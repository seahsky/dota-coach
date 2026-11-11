import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { CACHE_DIR } from "./cache.ts";
import { DotaError } from "./errors.ts";
import { heroName } from "./heroes.ts";
import { getPlayerMatches, parseAndWait } from "./players.ts";
import { type Profile, accountName, loadProfile, onMatchCommand, profileAccounts, saveProfile, steam64ToAccountId } from "./profile.ts";

export const SKILL_DIR = join(import.meta.dir, "..");
export const REVIEWS_DIR = join(SKILL_DIR, "reviews");
export const GSI_CFG_NAME = "gamestate_integration_dotacoach.cfg";
export const DEFAULT_GSI_PORT = 3742;
const STATE_FILE = join(CACHE_DIR, "watch-state.json");

// ---------- GSI config ----------

export function ensureGsiToken(profile: Profile = loadProfile()): string {
  if (!profile.gsi_token) {
    profile.gsi_token = randomBytes(16).toString("hex");
    saveProfile(profile);
  }
  return profile.gsi_token;
}

export function gsiConfig(port: number, token: string): string {
  // map carries matchid/game_state, player the local account id, hero the hero id.
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

export function dotaDirCandidates(): string[] {
  const rel = join("steamapps", "common", "dota 2 beta");
  const home = homedir();
  const roots =
    platform() === "win32"
      ? ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam", "D:\\SteamLibrary", "E:\\SteamLibrary", "D:\\Steam"]
      : platform() === "darwin"
        ? [join(home, "Library", "Application Support", "Steam")]
        : [
            join(home, ".steam", "steam"),
            join(home, ".local", "share", "Steam"),
            join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
          ];
  return roots.map((r) => join(r, rel));
}

export const isDotaDir = (dir: string) => existsSync(join(dir, "game", "dota"));
export const gsiCfgPath = (dotaDir: string) => join(dotaDir, "game", "dota", "cfg", "gamestate_integration", GSI_CFG_NAME);

export function findDotaDir(): string | null {
  return dotaDirCandidates().find(isDotaDir) ?? null;
}

/** Write the GSI config into the Dota install. Returns the file path. */
export function installGsi(dotaDir: string | null, port: number, token: string): string {
  const dir = dotaDir?.trim() || findDotaDir();
  if (!dir || !isDotaDir(dir)) {
    throw new DotaError(
      `Could not find the Dota 2 install${dotaDir ? ` at "${dotaDir}"` : ""}. ` +
        'Give the "dota 2 beta" folder (Steam: Dota 2 > Manage > Browse local files), ' +
        "or copy the config file in by hand.",
    );
  }
  const file = gsiCfgPath(dir);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, gsiConfig(port, token));
  return file;
}

/** What the installed config says, so the UI can tell whether it matches the current token and port. */
export function readInstalledGsi(dotaDir: string): { path: string; port: number | null; tokenMatches: boolean } | null {
  const path = gsiCfgPath(dotaDir);
  try {
    const text = readFileSync(path, "utf8");
    const port = Number(text.match(/"uri"\s+"http:\/\/[^:"]+:(\d+)/)?.[1]) || null;
    const token = text.match(/"token"\s+"([^"]*)"/)?.[1];
    return { path, port, tokenMatches: Boolean(token) && token === loadProfile().gsi_token };
  } catch {
    return null;
  }
}

// ---------- seen-match state ----------

function loadSeen(): Set<number> {
  try {
    return new Set((JSON.parse(readFileSync(STATE_FILE, "utf8")) as { seen: number[] }).seen);
  } catch {
    return new Set();
  }
}
function saveSeen(seen: Set<number>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ seen: [...seen].slice(-500) }));
  } catch {
    // Losing the seen list only risks a duplicate review.
  }
}

// ---------- watcher ----------

export interface Finished {
  matchId: number;
  accountId: number;
  hero?: string;
  via: "GSI" | "poll" | "test" | "dashboard";
}

export interface WatchOptions {
  port: number;
  gsi: boolean;
  /** Minutes between OpenDota polls; 0 = off. */
  pollMin: number;
  parse: boolean;
  review: boolean;
  waitMin: number;
}

export interface LogLine {
  at: number;
  text: string;
}

interface GsiPayload {
  provider?: { appid?: number };
  map?: { matchid?: string; game_state?: string; customgamename?: string };
  player?: { accountid?: string | number; steamid?: string };
  hero?: { id?: number };
  auth?: { token?: string };
}

export class Watcher {
  opts: WatchOptions;
  private seen = loadSeen();
  private queue: Finished[] = [];
  private current: Finished | null = null;
  private server: Server<undefined> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private warnedNoProfile = false;
  private logLines: LogLine[] = [];
  /** Last GSI post with a valid token: proves Dota is configured and talking to us. */
  lastGsi: { at: number; gameState: string | null; accountId: number | null } | null = null;
  startedAt: number | null = null;

  constructor(
    opts: Partial<WatchOptions> = {},
    private sink: (line: LogLine) => void = () => {},
  ) {
    this.opts = { port: DEFAULT_GSI_PORT, gsi: true, pollMin: 0, parse: true, review: true, waitMin: 15, ...opts };
  }

  log(text: string): void {
    const line = { at: Date.now(), text };
    this.logLines.push(line);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    this.sink(line);
  }

  get running(): boolean {
    return this.startedAt !== null;
  }

  private generation = 0;

  async start(): Promise<void> {
    if (this.running) return;
    const gen = ++this.generation;
    const accounts = this.myAccounts();
    if (!accounts.size) {
      if (!this.opts.gsi) throw new DotaError("Polling needs saved accounts. Add your account first.");
      this.log("No accounts in the profile yet; GSI will review games for whichever account is playing.");
    }
    if (this.opts.gsi) {
      const token = ensureGsiToken();
      try {
        this.server = Bun.serve({ hostname: "127.0.0.1", port: this.opts.port, fetch: (req) => this.onGsi(req, token) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DotaError(
          /in use|EADDRINUSE/i.test(msg)
            ? `Port ${this.opts.port} is already in use. Is another watcher (tools/WatchMatches.ts) running?`
            : `Could not listen on 127.0.0.1:${this.opts.port}: ${msg}`,
        );
      }
      this.log(`Listening for Dota 2 GSI on http://127.0.0.1:${this.opts.port}/.`);
    }
    this.startedAt = Date.now();
    if (this.opts.pollMin > 0 || !this.opts.gsi) {
      const every = this.opts.pollMin || 5;
      await this.pollOnce(true);
      // stop() or reconfigure() ran during the first poll: do not start an interval nobody can clear.
      if (gen !== this.generation || !this.running) return;
      this.pollTimer = setInterval(() => void this.pollOnce(false), every * 60_000);
      this.log(`Polling OpenDota every ${every} min for ${accounts.size} account(s).`);
    }
  }

  stop(): void {
    this.generation++;
    this.server?.stop(true);
    this.server = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.running) this.log("Watcher stopped.");
    this.startedAt = null;
  }

  /**
   * Change options without dropping the queue or a review in progress. If the
   * watcher was running and does not start with the new options, the old
   * options are restored and restarted, and the error is rethrown.
   */
  async reconfigure(next: WatchOptions): Promise<void> {
    const prev = this.opts;
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.opts = next;
    if (!wasRunning) return;
    try {
      await this.start();
    } catch (err) {
      this.opts = prev;
      await this.start().catch((e) => this.log(`Could not restart with the previous settings: ${e instanceof Error ? e.message : String(e)}`));
      throw err;
    }
  }

  status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      options: this.opts,
      lastGsi: this.lastGsi,
      current: this.current,
      queue: this.queue,
      log: this.logLines.slice(-50),
    };
  }

  /** Queue the after-match steps. `force` reviews a match again even if it was seen before. */
  enqueue(f: Finished, force = false): boolean {
    if (this.current?.matchId === f.matchId || this.queue.some((q) => q.matchId === f.matchId)) return false;
    if (!force && this.seen.has(f.matchId)) return false;
    this.seen.add(f.matchId);
    saveSeen(this.seen);
    this.queue.push(f);
    void this.drain();
    return true;
  }

  private draining: Promise<void> | null = null;
  private held = false;

  /**
   * Stop starting new reviews (they stay queued) or resume. Used while the skill updates
   * itself, so no review runs on files that are being replaced.
   */
  hold(on: boolean): void {
    this.held = on;
    if (!on) void this.drain();
  }

  /** Remove and return everything still queued (handed to the restarted process after an update). */
  takeQueue(): Finished[] {
    return this.queue.splice(0);
  }

  /** Process the queue; resolves when it is empty. Concurrent callers share one run. */
  drain(): Promise<void> {
    if (this.held) return this.draining ?? Promise.resolve();
    this.draining ??= this.runQueue().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async runQueue(): Promise<void> {
    while (this.queue.length && !this.held) {
      this.current = this.queue.shift()!;
      try {
        await this.afterMatch(this.current);
      } catch (err) {
        this.log(`match ${this.current.matchId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.current = null;
    }
  }

  private myAccounts(): Set<number> {
    return new Set(profileAccounts(loadProfile()).map((a) => a.account_id));
  }

  private async onGsi(req: Request, token: string): Promise<Response> {
    if (req.method !== "POST") return new Response("DotaCoach GSI listener\n");
    const body = (await req.json().catch(() => null)) as GsiPayload | null;
    if (!body || body.auth?.token !== token) return new Response("forbidden", { status: 403 });

    const accountId =
      Number(body.player?.accountid) || (body.player?.steamid ? steam64ToAccountId(body.player.steamid) : null) || null;
    this.lastGsi = { at: Date.now(), gameState: body.map?.game_state ?? null, accountId };

    const matchId = Number(body.map?.matchid);
    if (body.provider?.appid !== 570 || body.map?.game_state !== "DOTA_GAMERULES_STATE_POST_GAME" || !(matchId > 0)) {
      return new Response("ok");
    }
    if (body.map?.customgamename) return new Response("ok"); // arcade games are not on OpenDota
    // Spectating sends per-team player blocks without a top-level accountid; those are ignored.
    if (!accountId || this.seen.has(matchId)) return new Response("ok");

    const accounts = this.myAccounts();
    if (accounts.size && !accounts.has(accountId)) {
      this.log(`Match ${matchId} ended on account ${accountId}, which is not in the profile. Add it as an alt to get reviews.`);
      this.seen.add(matchId);
      return new Response("ok");
    }
    if (!accounts.size && !this.warnedNoProfile) {
      this.warnedNoProfile = true;
      this.log(`No profile saved; reviewing for account ${accountId}. Save it as your main account.`);
    }
    const hero = body.hero?.id ? await heroName(body.hero.id).catch(() => undefined) : undefined;
    this.enqueue({ matchId, accountId, hero, via: "GSI" });
    return new Response("ok");
  }

  private async pollOnce(firstRun: boolean): Promise<void> {
    for (const a of profileAccounts(loadProfile())) {
      try {
        const [m] = await getPlayerMatches(a.account_id, 1, 0);
        if (!m || this.seen.has(m.match_id)) continue;
        // On startup, remember the latest match instead of reviewing an old game.
        if (firstRun) {
          this.seen.add(m.match_id);
          continue;
        }
        this.enqueue({ matchId: m.match_id, accountId: a.account_id, hero: await heroName(m.hero_id), via: "poll" });
      } catch (err) {
        this.log(`poll ${a.account_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (firstRun) saveSeen(this.seen);
  }

  private async afterMatch(f: Finished): Promise<void> {
    const profile = loadProfile();
    const acc = profileAccounts(profile).find((a) => a.account_id === f.accountId);
    const who = acc ? `${accountName(acc)} (${acc.role})` : String(f.accountId);
    this.log(`Match ${f.matchId} finished on ${who}${f.hero ? `, ${f.hero}` : ""} (via ${f.via}).`);

    if (this.opts.parse) {
      this.log("Requesting an OpenDota parse; this usually takes 2-10 minutes after the game ends.");
      const r = await parseAndWait(f.matchId, this.opts.waitMin * 60_000, (s) => this.log(`  ${s}`));
      this.log(r === "parsed" ? "Replay parsed." : `Not parsed after ${this.opts.waitMin} min; reviewing with end-of-game data only.`);
    }
    if (!this.opts.review) return;

    mkdirSync(REVIEWS_DIR, { recursive: true });
    const file = join(REVIEWS_DIR, `${f.matchId}.md`);
    const custom = onMatchCommand(profile);
    const env = {
      ...process.env,
      DOTACOACH_MATCH_ID: String(f.matchId),
      DOTACOACH_ACCOUNT_ID: String(f.accountId),
      DOTACOACH_HERO: f.hero ?? "",
      DOTACOACH_REVIEW_FILE: file,
    };

    if (custom) {
      this.log(`Running the after-match command for ${f.matchId}`);
      // cmd.exe does not understand the \" escaping that normal argv quoting uses, so hand it the line verbatim.
      const win = platform() === "win32";
      const shell = win ? ["cmd", "/d", "/s", "/c", `"${custom}"`] : ["sh", "-c", custom];
      const p = Bun.spawn(shell, { cwd: SKILL_DIR, env, stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: win });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      for (const l of `${out}${err}`.trim().split("\n").filter(Boolean).slice(-20)) this.log(`  ${l}`);
      this.log(`After-match command exited ${code}`);
      return;
    }

    const claude = Bun.which("claude");
    if (!claude) {
      this.log(`\`claude\` is not on PATH. Open Claude Code and ask: "review my last Dota match" (match ${f.matchId}).`);
      return;
    }
    const prompt = [
      `Use the DotaCoach skill to review Dota 2 match ${f.matchId}. Follow workflows/MatchAnalysis.md.`,
      f.accountId
        ? `I played it on account ${f.accountId}${acc?.label ? ` ("${acc.label}")` : ""}${f.hero ? ` as ${f.hero}` : ""}; focus on my player.`
        : "Focus on the saved main account's player if it is in the match.",
      "Run `bun run tools/Profile.ts` first for my accounts and notes.",
      "This review runs automatically right after the game and nobody can answer questions:",
      "do not ask any, state assumptions instead. Keep it under 300 words and put the three takeaways first.",
    ].join(" ");
    this.log("Writing the review with Claude Code...");
    const p = Bun.spawn(
      [claude, "-p", prompt, "--allowedTools", "Bash(bun *)", "Bash(ID=* bun *)", "Read", "Glob", "Grep"],
      { cwd: SKILL_DIR, env, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0 || !out.trim()) {
      this.log(`claude exited ${code}: ${(err || out).trim().slice(0, 500)}`);
      return;
    }
    writeFileSync(file, `# Match ${f.matchId}\n\n${out.trim()}\n`);
    this.log(`Review saved: reviews/${f.matchId}.md`);
    this.sink({ at: Date.now(), text: `\n${"-".repeat(60)}\n${out.trim()}\n${"-".repeat(60)}` });
  }
}
