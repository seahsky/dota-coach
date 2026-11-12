import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import dashboardHtml from "../dashboard/index.html";
import { setCacheBackend } from "../lib/cache.ts";
import { accountsWithRank, maskKey, recentMatches, verifyAccount } from "../lib/dashboard.ts";
import { DotaError } from "../lib/errors.ts";
import { DEFAULT_BOUNDS, decodeMapImage, validateBounds } from "../lib/mapimage.ts";
import { addAlt, parseAccountId, profileAccounts, removeAccount, setMain } from "../lib/profile.ts";
import { buildMapData } from "../lib/replaymap.ts";
import { listReviews, readReview } from "../lib/reviews.ts";
import { setStore } from "../lib/store.ts";
import { stratzQuery } from "../lib/stratz.ts";
import { D1Cache, D1Store } from "./store.ts";
import { CloudWatcher, type GsiPayload, watchSettings } from "./watch.ts";

export interface Env {
  DB: D1Database;
  /** Secret: opens the dashboard (https://<worker>/?t=<token>). */
  DASHBOARD_TOKEN?: string;
  /** Secret: Claude API key for reviews. */
  ANTHROPIC_API_KEY?: string;
  /** Secret, optional: STRATZ token. */
  STRATZ_API_KEY?: string;
  DOTACOACH_MODEL?: string;
  DOTACOACH_EFFORT?: string;
}

// ---------- setup ----------

let db: D1Store | null = null;

function init(env: Env): { db: D1Store; watcher: CloudWatcher } {
  if (!db) {
    db = new D1Store(env.DB);
    setStore(db);
    setCacheBackend(new D1Cache(db));
  }
  // lib/stratz.ts and the review read keys from process.env, as they do under Bun.
  if (env.STRATZ_API_KEY) process.env.STRATZ_API_KEY = env.STRATZ_API_KEY;
  return { db, watcher: new CloudWatcher(db, env) };
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const bool = (v: unknown, name: string): boolean => {
  if (typeof v !== "boolean") throw new HttpError(400, `${name} must be true or false.`);
  return v;
};
const int = (v: unknown, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
};
const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== "string") throw new HttpError(400, `${name} is required.`);
  if (v.length > max) throw new HttpError(400, `${name} is too long.`);
  return v;
};

/** Constant-time string compare. */
function same(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>DotaCoach</title>` +
      `<body style="font:16px system-ui;max-width:40em;margin:3em auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

// Wrangler bundles .html as a text module; bun-types declares it as an HTML bundle instead.
const HTML = dashboardHtml as unknown as string;

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- GSI config ----------

function gsiConfig(origin: string, token: string): string {
  // Over the internet Dota posts on every change; a 10 s throttle keeps that to a few hundred
  // requests per game. hero is left out because it changes constantly; the poll fills it in.
  return `"DotaCoach"
{
    "uri"           "${origin}/gsi"
    "timeout"       "10.0"
    "buffer"        "5.0"
    "throttle"      "10.0"
    "heartbeat"     "60.0"
    "data"
    {
        "provider"  "1"
        "map"       "1"
        "player"    "1"
    }
    "auth"
    {
        "token"     "${token}"
    }
}
`;
}

// ---------- map picture (D1 rows hold up to 2 MB, so the picture is stored in chunks) ----------

const CHUNK = 1_500_000;

async function saveMapPicture(store: D1Store, dataUrl: string): Promise<void> {
  const { type } = decodeMapImage(dataUrl);
  const b64 = dataUrl.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  await store.deletePrefix("mapimage:");
  const n = Math.ceil(b64.length / CHUNK);
  for (let i = 0; i < n; i++) await store.put(`mapimage:${String(i).padStart(3, "0")}`, b64.slice(i * CHUNK, (i + 1) * CHUNK));
  await store.put("mapimage", JSON.stringify({ type, chunks: n }));
}

async function readMapPicture(store: D1Store): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  const meta = await store.get("mapimage");
  if (!meta) return null;
  const { type, chunks } = JSON.parse(meta) as { type: string; chunks: number };
  const parts = (await store.entries("mapimage:", chunks)).map((r) => r.value);
  if (parts.length !== chunks) return null;
  return { bytes: Uint8Array.from(atob(parts.join("")), (c) => c.charCodeAt(0)), type };
}

// ---------- API ----------

async function handleApi(req: Request, url: URL, env: Env): Promise<Response> {
  const { db, watcher } = init(env);
  const path = url.pathname;
  const method = req.method;
  const body = method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  async function ensureGsiToken() {
    const p = await watcher.profile();
    if (p.gsi_token) return p.gsi_token;
    p.gsi_token = randomToken();
    await watcher.saveProfile(p);
    return p.gsi_token;
  }

  async function state() {
    const p = await watcher.profile();
    const s = watchSettings(p);
    const [log, jobs, reviews, lastGsiRaw, mapMeta] = await Promise.all([
      watcher.logLines(),
      watcher.jobs(),
      listReviews(),
      db.get("lastgsi"),
      db.get("mapimage"),
    ]);
    const current = jobs.find((j) => j.state === "reviewing") ?? null;
    return {
      mode: "cloud",
      accounts: profileAccounts(p),
      notes: p.notes ?? "",
      stratz: { set: Boolean(env.STRATZ_API_KEY), masked: maskKey(env.STRATZ_API_KEY), fromEnvironment: false, editable: false },
      anthropic: { set: Boolean(env.ANTHROPIC_API_KEY), masked: maskKey(env.ANTHROPIC_API_KEY), fromEnvironment: false, editable: false },
      model: env.DOTACOACH_MODEL || null,
      onMatch: "",
      onMatchEffective: "",
      onMatchFromEnv: false,
      gsi: { url: `${url.origin}/gsi`, tokenSet: Boolean(p.gsi_token) },
      watchOptions: { ...s, port: 0, autostart: false },
      watcher: {
        running: s.enabled,
        startedAt: null,
        options: s,
        lastGsi: lastGsiRaw ? JSON.parse(lastGsiRaw) : null,
        current,
        queue: jobs.filter((j) => j !== current),
        log,
      },
      update: null,
      reviews,
      mapImage: { present: Boolean(mapMeta), bounds: p.map_bounds ?? DEFAULT_BOUNDS, defaults: DEFAULT_BOUNDS },
    };
  }

  if (method === "GET" && path === "/api/state") return json(await state());
  if (method === "GET" && path === "/api/accounts") return json({ accounts: await accountsWithRank(profileAccounts(await watcher.profile())) });

  if (method === "POST" && path === "/api/accounts") {
    const action = str(body.action, "action", 20);
    let message: string;
    if (action === "remove") {
      const p = await watcher.profile();
      message = removeAccount(p, parseAccountId(str(body.account, "account", 300)));
      await watcher.saveProfile(p);
    } else if (action === "set-main" || action === "add-alt") {
      const label = typeof body.label === "string" ? body.label.trim().slice(0, 40) || undefined : undefined;
      const acc = await verifyAccount(str(body.account, "account", 300), action === "set-main" ? (label ?? "main") : label);
      const p = await watcher.profile();
      message = action === "set-main" ? setMain(p, acc) : addAlt(p, acc);
      await watcher.saveProfile(p);
    } else {
      throw new HttpError(400, `Unknown action "${action}".`);
    }
    return json({ message, accounts: await accountsWithRank(profileAccounts(await watcher.profile())) });
  }

  if (method === "POST" && path === "/api/notes") {
    const p = await watcher.profile();
    const notes = str(body.notes, "notes", 2000).trim();
    if (notes) p.notes = notes;
    else delete p.notes;
    await watcher.saveProfile(p);
    return json({ message: notes ? "Notes saved." : "Notes cleared." });
  }

  if (method === "POST" && (path === "/api/stratz" || path === "/api/anthropic")) {
    const name = path === "/api/stratz" ? "STRATZ_API_KEY" : "ANTHROPIC_API_KEY";
    throw new HttpError(400, `On Cloudflare the key is a Worker secret. Run: npx wrangler secret put ${name}`);
  }

  if (method === "POST" && path === "/api/stratz/test") {
    if (!env.STRATZ_API_KEY) throw new HttpError(400, "No STRATZ_API_KEY secret set on the Worker.");
    try {
      await stratzQuery<{ __typename: string }>("query { __typename }", {}, 0);
      return json({ ok: true, message: "STRATZ accepted the key." });
    } catch (err) {
      return json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (method === "GET" && path === "/api/gsi/config") return json({ config: gsiConfig(url.origin, await ensureGsiToken()) });

  if (method === "POST" && path === "/api/watcher/options") {
    const p = await watcher.profile();
    const cur = watchSettings(p);
    const next = {
      enabled: cur.enabled,
      gsi: body.gsi === undefined ? cur.gsi : bool(body.gsi, "gsi"),
      pollMin: body.pollMin === undefined ? cur.pollMin : int(body.pollMin, "pollMin", 0, 120),
      parse: body.parse === undefined ? cur.parse : bool(body.parse, "parse"),
      review: body.review === undefined ? cur.review : bool(body.review, "review"),
      waitMin: body.waitMin === undefined ? cur.waitMin : int(body.waitMin, "waitMin", 1, 60),
    };
    if (!next.gsi && next.pollMin === 0) throw new HttpError(400, "Turn on GSI or polling, or the watcher has nothing to listen to.");
    p.watch = { ...p.watch, ...next };
    await watcher.saveProfile(p);
    return json({ message: "Watcher settings saved." });
  }

  if (method === "POST" && (path === "/api/watcher/start" || path === "/api/watcher/stop")) {
    const on = path.endsWith("start");
    const p = await watcher.profile();
    if (on && !profileAccounts(p).length && !watchSettings(p).gsi) throw new HttpError(400, "Polling needs saved accounts. Add your account first.");
    p.watch = { ...p.watch, enabled: on };
    if (on) await ensureGsiToken().then((t) => (p.gsi_token = t));
    await watcher.saveProfile(p);
    if (on) await db.delete("lastpoll"); // the next poll only remembers the latest match, like a fresh local watcher
    await watcher.log(on ? "Automatic reviews on." : "Automatic reviews off.");
    return json({ message: on ? "Automatic reviews on. The cloud checks once a minute." : "Automatic reviews off." });
  }

  if (method === "GET" && path === "/api/matches") {
    const count = int(url.searchParams.get("count") ?? 10, "count", 1, 20);
    const reviewed = new Set((await listReviews()).map((r) => r.matchId));
    return json(await recentMatches(profileAccounts(await watcher.profile()), count, reviewed));
  }

  if (method === "POST" && path === "/api/review") {
    const matchId = int(body.matchId, "matchId", 1, Number.MAX_SAFE_INTEGER);
    const accountId =
      body.accountId === undefined ? ((await watcher.profile()).main?.account_id ?? 0) : int(body.accountId, "accountId", 0, 0xffffffff);
    const hero = typeof body.hero === "string" && body.hero.trim() ? body.hero.trim().slice(0, 40) : undefined;
    const queued = await watcher.enqueue({ matchId, accountId, hero, via: "dashboard" }, true);
    return json({
      message: queued ? `Match ${matchId} queued. The review starts within a minute or two.` : `Match ${matchId} is already queued.`,
    });
  }

  if (method === "GET" && path === "/api/reviews") return json({ reviews: await listReviews() });
  const rev = path.match(/^\/api\/reviews\/(\d{1,20})$/);
  if (method === "GET" && rev) {
    const markdown = await readReview(rev[1]!);
    if (markdown === null) throw new HttpError(404, `No saved review for match ${rev[1]}.`);
    return json({ matchId: Number(rev[1]), markdown });
  }

  if (method === "GET" && path === "/api/map-image") {
    const img = await readMapPicture(db);
    if (!img) throw new HttpError(404, "No map picture saved.");
    return new Response(img.bytes, { headers: { "Content-Type": img.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  if (method === "POST" && path === "/api/map-image") {
    if (body.image === null) {
      await db.deletePrefix("mapimage:");
      await db.delete("mapimage");
      return json({ message: "Map picture removed; the map uses the drawn outline again." });
    }
    if (typeof body.image !== "string") throw new HttpError(400, "Send the picture as a data URL.");
    await saveMapPicture(db, body.image);
    return json({ message: "Map picture saved. Check that the marks line up; adjust the edges if they don't." });
  }
  if (method === "POST" && path === "/api/map-image/bounds") {
    const p = await watcher.profile();
    if (body.reset === true) delete p.map_bounds;
    else p.map_bounds = validateBounds(body.bounds);
    await watcher.saveProfile(p);
    return json({ message: body.reset === true ? "Map edges reset." : "Map edges saved." });
  }

  const mapReq = path.match(/^\/api\/map\/(\d{1,12})$/);
  if (method === "GET" && mapReq) {
    const acc = url.searchParams.get("account");
    const accounts = profileAccounts(await watcher.profile()).map((a) => a.account_id);
    if (acc && /^\d{1,10}$/.test(acc)) accounts.unshift(Number(acc));
    return json(await buildMapData(mapReq[1]!, { accounts }));
  }

  throw new HttpError(404, "Not found.");
}

// ---------- entry points ----------

const SESSION_COOKIE = "dc_session";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Dota's GSI posts here. Authenticated by the token in the config file, not the dashboard token.
    if (url.pathname === "/gsi") {
      if (req.method !== "POST") return new Response("DotaCoach GSI endpoint\n");
      const { watcher } = init(env);
      const payload = (await req.json().catch(() => null)) as GsiPayload | null;
      const token = (await watcher.profile()).gsi_token;
      if (!payload || !token || !same(payload.auth?.token ?? "", token)) return new Response("forbidden", { status: 403 });
      await watcher.onGsi(payload);
      return new Response("ok");
    }

    const secret = env.DASHBOARD_TOKEN?.trim();
    if (!secret || secret.length < 16) {
      return page(
        "Set a dashboard password first",
        "<p>This Worker has no <code>DASHBOARD_TOKEN</code> secret (or it is shorter than 16 characters). Set one, then open <code>/?t=&lt;token&gt;</code>:</p>" +
          "<pre>npx wrangler secret put DASHBOARD_TOKEN</pre>",
        503,
      );
    }

    if (url.pathname === "/" && req.method === "GET") {
      const t = url.searchParams.get("t");
      if (t !== null) {
        if (!same(t, secret)) return page("Wrong link", "<p>The token in this link does not match <code>DASHBOARD_TOKEN</code>.</p>", 401);
        // Swap the token in the address bar for a cookie, so it doesn't stay in history or get shared by accident.
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86_400}`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (!same(cookie(req, SESSION_COOKIE) ?? "", secret)) {
        return page("Open your dashboard link", "<p>Open <code>/?t=&lt;DASHBOARD_TOKEN&gt;</code> once; this browser then stays signed in for 30 days.</p>", 401);
      }
      return new Response(HTML.replace("__SESSION_TOKEN__", secret), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      // A custom header can't be sent cross-site without a CORS preflight we never allow, so this also stops CSRF.
      if (!same(req.headers.get("x-dotacoach-token") ?? "", secret)) return json({ error: "Signed out. Open your dashboard link again." }, 403);
      if (req.method === "POST" && !(req.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "Expected JSON." }, 415);
      try {
        return await handleApi(req, url, env);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : err instanceof DotaError ? 400 : 500;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 500) console.error(`Dashboard error: ${msg}`);
        return json({ error: msg }, status);
      }
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_ctl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { watcher } = init(env);
    ctx.waitUntil(
      watcher.tick().catch(async (err) => {
        console.error(err);
        await watcher.log(`Watcher error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }),
    );
  },
};
