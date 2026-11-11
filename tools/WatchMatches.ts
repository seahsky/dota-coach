import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CACHE_DIR } from "../lib/cache.ts";
import { intFlag, parseCli } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { heroName } from "../lib/heroes.ts";
import { getPlayerMatches, parseAndWait } from "../lib/players.ts";
import { type Profile, accountName, loadProfile, profileAccounts, saveProfile, steam64ToAccountId } from "../lib/profile.ts";

const USAGE = `bun run tools/WatchMatches.ts [options]

Runs in the background while you play. When one of your saved accounts (tools/Profile.ts) finishes a
match, it asks OpenDota to parse the replay, waits for the parse, then writes a coaching review.

Triggers:
  (default)               listen for Dota 2 Game State Integration on 127.0.0.1:<port>. Instant: Dota
                          posts the match id the moment the game ends. Needs --install-gsi once.
  --poll=MIN              also check OpenDota every MIN minutes for new matches (works without GSI,
                          e.g. Dota on another PC; a match shows up a few minutes after it ends)
  --no-gsi                polling only

Setup:
  --install-gsi           write the GSI config into the Dota install, then exit
  --dota-dir=DIR          the "dota 2 beta" folder for --install-gsi (default: the usual Steam paths)
  --print-gsi-config      print the config file instead of writing it, then exit
  --port=N                GSI port (default 3742)

After a match:
  --wait=MIN              how long to wait for OpenDota's parse (default 15)
  --no-parse              skip the parse request and review whatever OpenDota has
  --no-review             only request the parse
  --test=MATCH_ID         run the after-match steps once for MATCH_ID and exit

The review runs \`claude -p\` in the skill folder and is saved to reviews/<match_id>.md. Set
DOTACOACH_ON_MATCH to run your own command instead; it gets DOTACOACH_MATCH_ID, DOTACOACH_ACCOUNT_ID,
DOTACOACH_HERO and DOTACOACH_REVIEW_FILE in its environment.`;

const SKILL_DIR = join(import.meta.dir, "..");
const REVIEWS_DIR = join(SKILL_DIR, "reviews");
const STATE_FILE = join(CACHE_DIR, "watch-state.json");
const CFG_NAME = "gamestate_integration_dotacoach.cfg";

const log = (s: string) => process.stdout.write(`[${new Date().toLocaleTimeString()}] ${s}\n`);

// ---------- seen-match state ----------

function loadSeen(): Set<number> {
  try {
    return new Set((JSON.parse(readFileSync(STATE_FILE, "utf8")) as { seen: number[] }).seen);
  } catch {
    return new Set();
  }
}
function saveSeen(seen: Set<number>): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ seen: [...seen].slice(-500) }));
}

// ---------- GSI config ----------

function ensureToken(profile: Profile): string {
  if (!profile.gsi_token) {
    profile.gsi_token = randomBytes(16).toString("hex");
    saveProfile(profile);
  }
  return profile.gsi_token;
}

function gsiConfig(port: number, token: string): string {
  // Only map + player are needed: map carries matchid/game_state, player the local account id.
  return `"DotaCoach"
{
    "uri"           "http://127.0.0.1:${port}/"
    "timeout"       "5.0"
    "buffer"        "1.0"
    "throttle"      "1.0"
    "heartbeat"     "30.0"
    "data"
    {
        "provider"  "1"
        "map"       "1"
        "player"    "1"
        "hero"      "1"
    }
    "auth"
    {
        "token"     "${token}"
    }
}
`;
}

function dotaDirCandidates(): string[] {
  const rel = join("steamapps", "common", "dota 2 beta");
  const home = homedir();
  const roots =
    platform() === "win32"
      ? ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam", "D:\\SteamLibrary", "E:\\SteamLibrary", "D:\\Steam"]
      : platform() === "darwin"
        ? [join(home, "Library", "Application Support", "Steam")]
        : [join(home, ".steam", "steam"), join(home, ".local", "share", "Steam"), join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam")];
  return roots.map((r) => join(r, rel));
}

function installGsi(dirArg: string | true, port: number, token: string): void {
  const dir = typeof dirArg === "string" ? dirArg : dotaDirCandidates().find((d) => existsSync(join(d, "game", "dota")));
  if (!dir || !existsSync(join(dir, "game", "dota"))) {
    throw new DotaError(
      `Could not find the Dota 2 install${typeof dirArg === "string" ? ` at "${dirArg}"` : ""}. ` +
        'Pass the "dota 2 beta" folder: --install-gsi --dota-dir="<Steam library>/steamapps/common/dota 2 beta" ' +
        "(Steam: Dota 2 > Manage > Browse local files), or use --print-gsi-config and copy the file yourself.",
    );
  }
  const cfgDir = join(dir, "game", "dota", "cfg", "gamestate_integration");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, CFG_NAME), gsiConfig(port, token));
  process.stdout.write(
    `Wrote ${join(cfgDir, CFG_NAME)}\n\n` +
      "Two more steps:\n" +
      "  1. Steam > Dota 2 > Properties > Launch Options: add  -gamestateintegration\n" +
      "  2. Restart Dota, then start the watcher: bun run tools/WatchMatches.ts\n",
  );
}

// ---------- after-match pipeline ----------

interface Finished {
  matchId: number;
  accountId: number;
  hero?: string;
  via: "GSI" | "poll" | "test";
}

const queue: Finished[] = [];
let busy = false;

function enqueue(f: Finished, seen: Set<number>): void {
  if (seen.has(f.matchId) || queue.some((q) => q.matchId === f.matchId)) return;
  seen.add(f.matchId);
  saveSeen(seen);
  queue.push(f);
  void drain();
}

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const f = queue.shift()!;
    try {
      await afterMatch(f);
    } catch (err) {
      log(`match ${f.matchId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  busy = false;
}

let opts = { parse: true, review: true, waitMin: 15 };

async function afterMatch(f: Finished): Promise<void> {
  const profile = loadProfile();
  const acc = profileAccounts(profile).find((a) => a.account_id === f.accountId);
  const who = acc ? `${accountName(acc)} (${acc.role})` : String(f.accountId);
  log(`\x07Match ${f.matchId} finished on ${who}${f.hero ? `, ${f.hero}` : ""} (via ${f.via}).`);

  if (opts.parse) {
    log("Requesting an OpenDota parse; this usually takes 2-10 minutes after the game ends.");
    const r = await parseAndWait(f.matchId, opts.waitMin * 60_000, (s) => log(`  ${s}`));
    log(r === "parsed" ? "Replay parsed." : `Not parsed after ${opts.waitMin} min; reviewing with end-of-game data only.`);
  }
  if (!opts.review) return;

  mkdirSync(REVIEWS_DIR, { recursive: true });
  const file = join(REVIEWS_DIR, `${f.matchId}.md`);
  const custom = process.env.DOTACOACH_ON_MATCH?.trim();
  const env = {
    ...process.env,
    DOTACOACH_MATCH_ID: String(f.matchId),
    DOTACOACH_ACCOUNT_ID: String(f.accountId),
    DOTACOACH_HERO: f.hero ?? "",
    DOTACOACH_REVIEW_FILE: file,
  };

  if (custom) {
    log(`Running DOTACOACH_ON_MATCH for ${f.matchId}`);
    const shell = platform() === "win32" ? ["cmd", "/c", custom] : ["sh", "-c", custom];
    const p = Bun.spawn(shell, { cwd: SKILL_DIR, env, stdout: "inherit", stderr: "inherit" });
    log(`DOTACOACH_ON_MATCH exited ${await p.exited}`);
    return;
  }

  const claude = Bun.which("claude");
  if (!claude) {
    log(`\`claude\` is not on PATH. Open Claude Code and ask: "review my last Dota match" (match ${f.matchId}).`);
    return;
  }
  const prompt = [
    `Use the DotaCoach skill to review Dota 2 match ${f.matchId}. Follow workflows/MatchAnalysis.md.`,
    `I played it on account ${f.accountId}${acc?.label ? ` ("${acc.label}")` : ""}${f.hero ? ` as ${f.hero}` : ""}; focus on my player.`,
    "Run `bun run tools/Profile.ts` first for my accounts and notes.",
    "This review runs automatically right after the game and nobody can answer questions:",
    "do not ask any, state assumptions instead. Keep it under 300 words and put the three takeaways first.",
  ].join(" ");
  log("Writing the review with Claude Code...");
  const p = Bun.spawn(
    [claude, "-p", prompt, "--allowedTools", "Bash(bun *)", "Bash(ID=* bun *)", "Read", "Glob", "Grep"],
    { cwd: SKILL_DIR, env, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 || !out.trim()) {
    log(`claude exited ${code}: ${(err || out).trim().slice(0, 500)}`);
    return;
  }
  writeFileSync(file, `# Match ${f.matchId}\n\n${out.trim()}\n`);
  process.stdout.write(`\n${"-".repeat(60)}\n${out.trim()}\n${"-".repeat(60)}\n`);
  log(`Saved to ${file}`);
}

// ---------- triggers ----------

interface GsiPayload {
  provider?: { appid?: number };
  map?: { matchid?: string; game_state?: string; customgamename?: string };
  player?: { accountid?: string | number; steamid?: string };
  hero?: { id?: number };
  auth?: { token?: string };
}

function startGsi(port: number, token: string, mine: () => Set<number>, seen: Set<number>): void {
  let warnedNoProfile = false;
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      if (req.method !== "POST") return new Response("DotaCoach GSI listener\n");
      const body = (await req.json().catch(() => null)) as GsiPayload | null;
      if (!body || body.auth?.token !== token) return new Response("forbidden", { status: 403 });
      const state = body.map?.game_state;
      const matchId = Number(body.map?.matchid);
      if (body.provider?.appid !== 570 || state !== "DOTA_GAMERULES_STATE_POST_GAME" || !(matchId > 0)) return new Response("ok");
      if (body.map?.customgamename) return new Response("ok"); // arcade games are not on OpenDota

      // Spectating sends per-team player blocks without a top-level accountid; those are ignored.
      const accountId =
        Number(body.player?.accountid) || (body.player?.steamid ? steam64ToAccountId(body.player.steamid) : null);
      if (!accountId) return new Response("ok");
      const accounts = mine();
      if (accounts.size && !accounts.has(accountId)) {
        log(`Match ${matchId} ended on account ${accountId}, which is not in the profile. Add it: bun run tools/Profile.ts add-alt ${accountId}`);
        seen.add(matchId);
        return new Response("ok");
      }
      if (!accounts.size && !warnedNoProfile) {
        warnedNoProfile = true;
        log(`No profile saved; reviewing for account ${accountId}. Save it: bun run tools/Profile.ts set-main ${accountId}`);
      }
      const hero = body.hero?.id ? await heroName(body.hero.id).catch(() => undefined) : undefined;
      enqueue({ matchId, accountId, hero, via: "GSI" }, seen);
      return new Response("ok");
    },
  });
  log(`Listening for Dota 2 GSI on http://127.0.0.1:${port}/ (GSI config: ${CFG_NAME}).`);
}

async function pollOnce(seen: Set<number>, firstRun: boolean): Promise<void> {
  for (const a of profileAccounts(loadProfile())) {
    try {
      const [m] = await getPlayerMatches(a.account_id, 1, 0);
      if (!m || seen.has(m.match_id)) continue;
      // On startup, remember the latest match instead of reviewing an old game.
      if (firstRun) {
        seen.add(m.match_id);
        continue;
      }
      enqueue({ matchId: m.match_id, accountId: a.account_id, hero: await heroName(m.hero_id), via: "poll" }, seen);
    } catch (err) {
      log(`poll ${a.account_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (firstRun) saveSeen(seen);
}

// ---------- main ----------

await main(async () => {
  const args = parseCli(USAGE, {
    strings: ["port", "poll", "wait", "test", "dota-dir"],
    booleans: ["install-gsi", "no-gsi", "no-parse", "no-review", "print-gsi-config"],
  });
  const port = intFlag(args.flags.port, "port", 3742, 1024, 65535);
  const pollMin = args.flags.poll === undefined ? 0 : intFlag(args.flags.poll, "poll", 5, 1, 120);
  opts = { parse: !args.flags["no-parse"], review: !args.flags["no-review"], waitMin: intFlag(args.flags.wait, "wait", 15, 1, 60) };

  const profile = loadProfile();
  const token = ensureToken(profile);

  if (args.flags["print-gsi-config"]) {
    process.stdout.write(
      `# Save as <dota 2 beta>/game/dota/cfg/gamestate_integration/${CFG_NAME}\n` +
        "# and add -gamestateintegration to Dota's Steam launch options.\n\n" +
        gsiConfig(port, token),
    );
    return;
  }
  if (args.flags["install-gsi"]) {
    const dir = typeof args.flags["dota-dir"] === "string" ? args.flags["dota-dir"].trim() : "";
    installGsi(dir || true, port, token);
    return;
  }

  const seen = loadSeen();
  if (typeof args.flags.test === "string") {
    const matchId = Number(args.flags.test);
    if (!Number.isInteger(matchId) || matchId <= 0) throw new DotaError(`--test needs a match id (got "${args.flags.test}").`);
    const accountId = profile.main?.account_id ?? 0;
    queue.push({ matchId, accountId, via: "test" });
    await drain();
    return;
  }

  const mine = () => new Set(profileAccounts(loadProfile()).map((a) => a.account_id));
  if (!mine().size) {
    log("No accounts in the profile yet. Run: bun run tools/Profile.ts set-main <your Friend ID>");
    if (args.flags["no-gsi"]) throw new DotaError("Polling needs saved accounts.");
  }
  if (!args.flags["no-gsi"]) startGsi(port, token, mine, seen);
  if (pollMin || args.flags["no-gsi"]) {
    const every = pollMin || 5;
    await pollOnce(seen, true);
    setInterval(() => void pollOnce(seen, false), every * 60_000);
    log(`Polling OpenDota every ${every} min for ${mine().size} account(s).`);
  }
  log("Watching. Leave this window open while you play; Ctrl+C to stop.");
});
