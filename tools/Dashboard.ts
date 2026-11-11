import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { intFlag, parseCli } from "../lib/cli.ts";
import { ENV_FILE, fromEnvironment, setEnvValue, setInEnvironment } from "../lib/env.ts";
import { DotaError, main } from "../lib/errors.ts";
import { heroName } from "../lib/heroes.ts";
import { getPlayer, getPlayerMatches, playerWon, rankName } from "../lib/players.ts";
import {
  PROFILE_FILE,
  addAlt,
  loadProfile,
  onMatchCommand,
  parseAccountId,
  profileAccounts,
  removeAccount,
  saveProfile,
  setMain,
} from "../lib/profile.ts";
import { hasStratzKey, stratzQuery } from "../lib/stratz.ts";
import { type UpdateStatus, applyUpdate, checkForUpdate } from "../lib/update.ts";
import {
  DEFAULT_GSI_PORT,
  REVIEWS_DIR,
  SKILL_DIR,
  Watcher,
  ensureGsiToken,
  findDotaDir,
  gsiConfig,
  installGsi,
  isDotaDir,
  readInstalledGsi,
} from "../lib/watcher.ts";

const USAGE = `bun run tools/Dashboard.ts [--port=N] [--no-open] [--no-update]

Opens a local setup page at http://127.0.0.1:<port>/?t=<token> (default port 3743): your accounts and
notes, the STRATZ key, the Dota 2 Game State Integration config, the post-game watcher, and saved
reviews. The page only listens on this computer, and only the link printed in the terminal opens it
(the token changes every run). Ctrl+C to stop; the watcher stops with it.

On start it checks GitHub for a newer version of the skill and installs it first (fast-forward only;
your profile.json, .env and reviews/ are never touched). --no-update skips that for one run; the
"Update automatically" setting on the page turns it off for good.`;

/** Run this same command again in a child process and exit with its code (after an update). */
async function reexec(env: Record<string, string>, extraArgs: string[] = []): Promise<never> {
  const argv = [...process.argv.slice(1), ...extraArgs.filter((a) => !process.argv.includes(a))];
  const child = Bun.spawn([process.execPath, ...argv], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await child.exited);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HTML_FILE = join(SKILL_DIR, "dashboard", "index.html");

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

function maskKey(key: string | undefined): string | null {
  const k = key?.trim();
  if (!k) return null;
  return k.length <= 8 ? "set" : `${k.slice(0, 4)}...${k.slice(-4)}`;
}

function listReviews(): { matchId: number; savedAt: number }[] {
  try {
    return readdirSync(REVIEWS_DIR)
      .map((f) => f.match(/^(\d+)\.md$/)?.[1])
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ matchId: Number(id), savedAt: statSync(join(REVIEWS_DIR, `${id}.md`)).mtimeMs }))
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

function openBrowser(url: string): void {
  const cmd =
    platform() === "win32" ? ["cmd", "/c", "start", "", url] : platform() === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    p.exited.catch(() => {});
  } catch {
    // No browser launcher (headless box, WSL without wslu): the URL is printed anyway.
  }
}

/**
 * Like Jupyter: open the browser on a private redirect file instead of the token URL, so the
 * token never appears in a process command line (readable by other users on Linux via ps).
 */
function launcherFile(url: string): string {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dotacoach-"));
    const file = join(dir, "open-dashboard.html");
    writeFileSync(
      file,
      `<!doctype html><meta charset=utf-8><meta http-equiv="refresh" content="0;url=${url}"><title>DotaCoach Setup</title><a href="${url}">Open the DotaCoach dashboard</a>`,
      { mode: 0o600 },
    );
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
    return pathToFileURL(file).href;
  } catch {
    return url;
  }
}

function watcherOptions() {
  const w = loadProfile().watch ?? {};
  // autostart is a dashboard setting, not a Watcher option; Watcher ignores the extra field.
  return {
    port: w.port ?? DEFAULT_GSI_PORT,
    gsi: w.gsi ?? true,
    pollMin: w.pollMin ?? 0,
    parse: w.parse ?? true,
    review: w.review ?? true,
    waitMin: w.waitMin ?? 15,
    autostart: w.autostart ?? false,
  };
}

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

await main(async () => {
  const args = parseCli(USAGE, { strings: ["port"], booleans: ["no-open", "no-update"] });
  const port = intFlag(args.flags.port, "port", 3743, 1024, 65535);

  // Update before anything is loaded or served, then rerun on the new code. DOTACOACH_UPDATED stops loops.
  let updateStatus: UpdateStatus | null = null;
  if (!process.env.DOTACOACH_UPDATED && !args.flags["no-update"] && loadProfile().update?.auto !== false) {
    process.stdout.write("Checking for skill updates...\n");
    const r = await applyUpdate();
    updateStatus = r.status;
    if (r.updated) {
      process.stdout.write(`${r.status.message}\n${r.status.incoming.map((s) => `  - ${s}`).join("\n")}\nRestarting on the new version...\n\n`);
      await reexec({ DOTACOACH_UPDATED: "1" });
    }
    if (r.error) process.stdout.write(`Update failed: ${r.error}\n`);
    else if (r.status.state !== "up-to-date") process.stdout.write(`${r.status.message}\n`);
  }
  if (!existsSync(HTML_FILE)) throw new DotaError(`Missing ${HTML_FILE}. Is the skill checkout complete?`);

  // After an update from the page, the new process keeps the old token so the open tab keeps working.
  const inherited = process.env.DOTACOACH_SESSION_TOKEN;
  delete process.env.DOTACOACH_SESSION_TOKEN; // not passed on to claude -p or the after-match command
  const sessionToken = inherited && /^[0-9a-f]{48}$/.test(inherited) ? inherited : randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(sessionToken);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const print = ({ at, text }: { at: number; text: string }) =>
    process.stdout.write(text.startsWith("\n") ? `${text}\n` : `[${new Date(at).toLocaleTimeString()}] ${text}\n`);
  const watcher = new Watcher(watcherOptions(), print);
  let updateChecking = false;

  // ---------- API handlers ----------

  async function accountsWithRank() {
    return Promise.all(
      profileAccounts(loadProfile()).map(async (a) => {
        try {
          const p = await getPlayer(a.account_id);
          return { ...a, persona: p.profile?.personaname ?? a.persona ?? null, rank: rankName(p.rank_tier, p.leaderboard_rank), error: null };
        } catch (err) {
          return { ...a, persona: a.persona ?? null, rank: null, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  function state() {
    const profile = loadProfile();
    const opts = watcherOptions();
    const dotaDir = profile.dota_dir ?? findDotaDir();
    const installed = dotaDir && isDotaDir(dotaDir) ? readInstalledGsi(dotaDir) : null;
    return {
      skillDir: SKILL_DIR,
      profileFile: PROFILE_FILE,
      envFile: ENV_FILE,
      accounts: profileAccounts(profile),
      notes: profile.notes ?? "",
      stratz: { set: hasStratzKey(), masked: maskKey(process.env.STRATZ_API_KEY), fromEnvironment: fromEnvironment("STRATZ_API_KEY") },
      onMatch: profile.watch?.onMatch ?? "",
      onMatchEffective: onMatchCommand(profile),
      onMatchFromEnv: !profile.watch?.onMatch && Boolean(process.env.DOTACOACH_ON_MATCH?.trim()),
      dashboardPort: port,
      pid: process.pid,
      claudeOnPath: Boolean(Bun.which("claude")),
      gsi: {
        dotaDir: dotaDir ?? null,
        dotaDirValid: Boolean(dotaDir && isDotaDir(dotaDir)),
        detected: findDotaDir(),
        installed,
        upToDate: Boolean(installed && installed.tokenMatches && installed.port === opts.port),
      },
      watchOptions: opts,
      update: { auto: profile.update?.auto !== false, status: updateStatus, checking: updateChecking },
      watcher: watcher.status(),
      reviews: listReviews(),
    };
  }

  async function verifyAccount(input: string, label?: string) {
    const id = parseAccountId(input);
    const p = await getPlayer(id);
    return { account_id: id, ...(label ? { label } : {}), persona: p.profile?.personaname ?? undefined };
  }

  async function recentMatches(count: number) {
    const accounts = profileAccounts(loadProfile());
    const have = new Set(listReviews().map((r) => r.matchId));
    const per = await Promise.all(
      accounts.map(async (a) => {
        try {
          return { a, matches: await getPlayerMatches(a.account_id, count), error: null };
        } catch (err) {
          return { a, matches: [], error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    const rows = [];
    for (const { a, matches } of per) {
      for (const m of matches) {
        rows.push({
          matchId: m.match_id,
          accountId: a.account_id,
          account: a.label ?? a.persona ?? String(a.account_id),
          role: a.role,
          hero: await heroName(m.hero_id).catch(() => `Hero ${m.hero_id}`),
          won: playerWon(m),
          kda: `${m.kills}/${m.deaths}/${m.assists}`,
          startTime: m.start_time,
          endTime: m.start_time + m.duration,
          duration: m.duration,
          parsed: Boolean(m.version),
          hasReview: have.has(m.match_id),
        });
      }
    }
    rows.sort((x, y) => y.startTime - x.startTime);
    return { matches: rows.slice(0, count), errors: per.filter((p) => p.error).map((p) => `${p.a.account_id}: ${p.error}`) };
  }

  async function handleApi(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    const body = method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

    if (method === "GET" && path === "/api/state") return json(state());
    if (method === "GET" && path === "/api/accounts") return json({ accounts: await accountsWithRank() });

    if (method === "POST" && path === "/api/accounts") {
      const action = str(body.action, "action", 20);
      let message: string;
      if (action === "remove") {
        const profile = loadProfile();
        message = removeAccount(profile, parseAccountId(str(body.account, "account", 300)));
        saveProfile(profile);
      } else if (action === "set-main" || action === "add-alt") {
        const label = typeof body.label === "string" ? body.label.trim().slice(0, 40) || undefined : undefined;
        // Verify first: the OpenDota call can take seconds, and loading the profile before it
        // would overwrite notes or settings saved in the meantime.
        const acc = await verifyAccount(str(body.account, "account", 300), action === "set-main" ? (label ?? "main") : label);
        const profile = loadProfile();
        message = action === "set-main" ? setMain(profile, acc) : addAlt(profile, acc);
        saveProfile(profile);
      } else {
        throw new HttpError(400, `Unknown action "${action}".`);
      }
      return json({ message, accounts: await accountsWithRank() });
    }

    if (method === "POST" && path === "/api/notes") {
      const profile = loadProfile();
      const notes = str(body.notes, "notes", 2000).trim();
      if (notes) profile.notes = notes;
      else delete profile.notes;
      saveProfile(profile);
      return json({ message: notes ? "Notes saved." : "Notes cleared." });
    }

    if (method === "POST" && path === "/api/stratz") {
      const key = body.key === null ? null : str(body.key, "key", 4000).trim();
      if (key && !/^[\x21-\x7e]+$/.test(key)) throw new HttpError(400, "That does not look like a STRATZ token (spaces or unusual characters).");
      try {
        setEnvValue("STRATZ_API_KEY", key || null);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      const note = !setInEnvironment("STRATZ_API_KEY")
        ? ""
        : key
          ? " STRATZ_API_KEY is also set in your shell or system environment, which wins after a restart; change or remove it there."
          : " STRATZ_API_KEY is still set in your shell or system environment, so that key stays in use; remove it there to turn STRATZ off.";
      return json({ message: (key ? "STRATZ key saved to .env." : "STRATZ key removed from .env.") + note });
    }

    if (method === "POST" && path === "/api/stratz/test") {
      if (!hasStratzKey()) throw new HttpError(400, "No STRATZ key saved.");
      try {
        // A trivial query: proves the token is accepted without depending on any schema field.
        await stratzQuery<{ __typename: string }>("query { __typename }", {}, 0);
        return json({ ok: true, message: "STRATZ accepted the key." });
      } catch (err) {
        return json({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "POST" && path === "/api/settings") {
      const onMatch = str(body.onMatch, "onMatch", 1000).trim();
      if (/[\r\n]/.test(onMatch)) throw new HttpError(400, "The command must be one line.");
      const profile = loadProfile();
      profile.watch = { ...profile.watch, onMatch: onMatch || undefined };
      saveProfile(profile);
      const env = process.env.DOTACOACH_ON_MATCH?.trim();
      return json({
        message: onMatch
          ? "After-match command saved."
          : env
            ? "Command cleared here, but DOTACOACH_ON_MATCH is still set in your environment or .env, so that command runs."
            : "Command cleared; reviews use claude -p.",
      });
    }

    if (method === "GET" && path === "/api/gsi/config") {
      return json({ config: gsiConfig(watcherOptions().port, ensureGsiToken()) });
    }

    if (method === "POST" && path === "/api/gsi/install") {
      const dir = typeof body.dotaDir === "string" && body.dotaDir.trim() ? body.dotaDir.trim() : null;
      const file = installGsi(dir, watcherOptions().port, ensureGsiToken());
      const profile = loadProfile();
      profile.dota_dir = join(file, "..", "..", "..", "..", "..");
      saveProfile(profile);
      return json({ message: `Wrote ${file}. Add -gamestateintegration to Dota's launch options and restart Dota.`, file });
    }

    if (method === "POST" && path === "/api/watcher/options") {
      const cur = watcherOptions();
      const next = {
        port: body.port === undefined ? cur.port : int(body.port, "port", 1024, 65535),
        gsi: body.gsi === undefined ? cur.gsi : bool(body.gsi, "gsi"),
        pollMin: body.pollMin === undefined ? cur.pollMin : int(body.pollMin, "pollMin", 0, 120),
        parse: body.parse === undefined ? cur.parse : bool(body.parse, "parse"),
        review: body.review === undefined ? cur.review : bool(body.review, "review"),
        waitMin: body.waitMin === undefined ? cur.waitMin : int(body.waitMin, "waitMin", 1, 60),
        autostart: body.autostart === undefined ? cur.autostart : bool(body.autostart, "autostart"),
      };
      if (next.port === port) throw new HttpError(400, `Port ${port} is the dashboard's own port. Pick another for GSI.`);
      if (!next.gsi && next.pollMin === 0) throw new HttpError(400, "Turn on GSI or polling, or the watcher has nothing to listen to.");
      const restart = watcher.running;
      try {
        // Same Watcher instance: a review in progress and the queue are kept.
        await watcher.reconfigure(next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HttpError(400, `Settings not saved: ${msg} The watcher kept its previous settings${watcher.running ? " and is still running" : ""}.`);
      }
      const profile = loadProfile();
      profile.watch = { ...profile.watch, ...next };
      saveProfile(profile);
      return json({
        message:
          "Watcher settings saved." +
          (restart ? " Watcher restarted." : "") +
          (next.port !== cur.port ? " The GSI port changed: install the GSI config again so Dota uses the new port." : ""),
      });
    }

    if (method === "POST" && path === "/api/watcher/start") {
      if (watcher.opts.gsi && watcher.opts.port === port) {
        throw new HttpError(400, `The GSI port (${port}) is the dashboard's own port. Change the GSI port in the watcher settings.`);
      }
      await watcher.start();
      return json({ message: "Watcher started." });
    }
    if (method === "POST" && path === "/api/watcher/stop") {
      watcher.stop();
      return json({ message: "Watcher stopped." });
    }

    if (method === "GET" && path === "/api/matches") {
      const count = int(url.searchParams.get("count") ?? 10, "count", 1, 20);
      return json(await recentMatches(count));
    }

    if (method === "POST" && path === "/api/review") {
      const matchId = int(body.matchId, "matchId", 1, Number.MAX_SAFE_INTEGER);
      const accountId = body.accountId === undefined ? loadProfile().main?.account_id ?? 0 : int(body.accountId, "accountId", 0, 0xffffffff);
      const hero = typeof body.hero === "string" && body.hero.trim() ? body.hero.trim().slice(0, 40) : undefined;
      const queued = watcher.enqueue({ matchId, accountId, hero, via: "dashboard" }, true);
      return json({ message: queued ? `Match ${matchId} queued for review.` : `Match ${matchId} is already being reviewed.` });
    }

    if (method === "POST" && path === "/api/update/check") {
      updateChecking = true;
      try {
        updateStatus = await checkForUpdate();
      } finally {
        updateChecking = false;
      }
      return json({ message: updateStatus.message });
    }

    if (method === "POST" && path === "/api/update/auto") {
      const profile = loadProfile();
      profile.update = { ...profile.update, auto: bool(body.auto, "auto") };
      saveProfile(profile);
      return json({ message: profile.update.auto ? "The skill will update itself when the dashboard starts." : "Automatic updates off." });
    }

    if (method === "POST" && path === "/api/update/apply") {
      const st = watcher.status();
      if (st.current || st.queue.length) throw new HttpError(409, "A review is running. Update when it finishes.");
      const r = await applyUpdate();
      updateStatus = r.status;
      if (r.error) throw new HttpError(500, `Update failed: ${r.error}`);
      if (!r.updated) throw new HttpError(409, r.status.message);
      // Restart on the new code after this response is sent, on the same port and token.
      setTimeout(() => void restartAfterUpdate(st.running), 300);
      return json({ message: `${r.status.message} Restarting the dashboard; the page reconnects in a few seconds.`, restarting: true });
    }

    if (method === "GET" && path === "/api/reviews") return json({ reviews: listReviews() });
    const rev = path.match(/^\/api\/reviews\/(\d{1,20})$/);
    if (method === "GET" && rev) {
      try {
        return json({ matchId: Number(rev[1]), markdown: readFileSync(join(REVIEWS_DIR, `${rev[1]}.md`), "utf8") });
      } catch {
        throw new HttpError(404, `No saved review for match ${rev[1]}.`);
      }
    }

    throw new HttpError(404, "Not found.");
  }

  // ---------- server ----------

  async function restartAfterUpdate(watcherWasRunning: boolean): Promise<void> {
    process.stdout.write("\nSkill updated. Restarting on the new version...\n\n");
    watcher.stop();
    server?.stop(true);
    await reexec(
      { DOTACOACH_UPDATED: "1", DOTACOACH_SESSION_TOKEN: sessionToken, ...(watcherWasRunning ? { DOTACOACH_RESUME_WATCHER: "1" } : {}) },
      ["--no-open"],
    );
  }

  let server: ReturnType<typeof Bun.serve> | null = null;
  const serve = () => Bun.serve({
    hostname: "127.0.0.1",
    port,
    // OpenDota can take 15s+ per call; Bun's default 10s idle timeout would drop /api/matches and /api/accounts.
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      // DNS-rebinding guard: a page on another site resolved to 127.0.0.1 still sends its own Host.
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Bad host", { status: 421 });

      if (url.pathname === "/" && req.method === "GET") {
        // Like Jupyter: only the link printed in the terminal (with ?t=) gets the page and its token,
        // so another local user or process cannot just fetch it.
        const t = Buffer.from(url.searchParams.get("t") ?? "");
        if (t.length !== tokenBuf.length || !timingSafeEqual(t, tokenBuf)) {
          return new Response(
            "<!doctype html><meta charset=utf-8><title>DotaCoach Setup</title><body style=\"font:16px system-ui;max-width:40em;margin:3em auto;padding:0 16px\">" +
              "<h1 style=\"font-size:20px\">Open the link from the terminal</h1><p>For safety this page only opens from the link <code>tools/Dashboard.ts</code> printed when it started " +
              "(it ends in <code>?t=</code> and a code that changes every run). Copy it from the terminal window.</p>",
            { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
          );
        }
        const html = readFileSync(HTML_FILE, "utf8").replace("__SESSION_TOKEN__", sessionToken);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      if (url.pathname.startsWith("/api/")) {
        const given = Buffer.from(req.headers.get("x-dotacoach-token") ?? "");
        if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) return json({ error: "Reload the page." }, 403);
        if (req.method === "POST" && !(req.headers.get("content-type") ?? "").includes("application/json")) {
          return json({ error: "Expected JSON." }, 415);
        }
        try {
          return await handleApi(req, url);
        } catch (err) {
          const status = err instanceof HttpError ? err.status : err instanceof DotaError ? 400 : 500;
          const msg = err instanceof Error ? err.message : String(err);
          if (status === 500) process.stderr.write(`Dashboard error: ${msg}\n`);
          return json({ error: msg }, status);
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });
  try {
    // After a restart from the page, the old process may need a moment to release the port.
    for (let attempt = 0; ; attempt++) {
      try {
        server = serve();
        break;
      } catch (err) {
        if (!inherited || attempt >= 20) throw err;
        await sleep(250);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DotaError(
      /in use|EADDRINUSE/i.test(msg)
        ? `Port ${port} is in use. Is the dashboard already open? Otherwise pass --port=<another>.`
        : `Could not listen on 127.0.0.1:${port}: ${msg}`,
    );
  }

  const url = `http://127.0.0.1:${port}/?t=${sessionToken}`;
  process.stdout.write(`DotaCoach dashboard: ${url}\nOpen that exact link (it changes every run). Ctrl+C to stop.\n`);
  if (watcherOptions().autostart && watcher.opts.gsi && watcher.opts.port === port) {
    watcher.log(`Watcher not started: its GSI port ${port} is the dashboard's own port. Change the GSI port in the watcher settings.`);
  } else if (watcherOptions().autostart || process.env.DOTACOACH_RESUME_WATCHER) {
    try {
      await watcher.start();
    } catch (err) {
      watcher.log(`Watcher did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  delete process.env.DOTACOACH_RESUME_WATCHER;
  delete process.env.DOTACOACH_UPDATED;
  if (!args.flags["no-open"]) openBrowser(launcherFile(url));

  // Look for updates now and then; the page shows a banner, nothing installs without a click.
  if (!updateStatus) void checkForUpdate().then((s) => (updateStatus = s)).catch(() => {});
  setInterval(() => void checkForUpdate().then((s) => (updateStatus = s)).catch(() => {}), 6 * 3600_000);
});
