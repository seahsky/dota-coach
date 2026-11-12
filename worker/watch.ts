import { reviewMatch } from "../lib/coach/review.ts";
import { heroName } from "../lib/heroes.ts";
import { getPlayerMatches, matchParsed, parseJobPending, requestParse } from "../lib/players.ts";
import { type Profile, accountName, profileAccounts, steam64ToAccountId } from "../lib/profile.ts";
import { saveReview } from "../lib/reviews.ts";
import type { D1Store } from "./store.ts";

/**
 * The post-game watcher in the cloud. The local watcher (lib/watcher.ts) waits in one long-lived
 * process; a Worker can't, so each match is a job row that the once-a-minute cron moves along:
 *
 *   parse  -> ask OpenDota to parse, then check once a minute until parsed or the wait runs out
 *   review -> claimed by one cron run, which writes the review with Claude and deletes the job
 */

export interface WatchSettings {
  /** Automatic reviews on (the dashboard's Start/Stop). */
  enabled: boolean;
  gsi: boolean;
  pollMin: number;
  parse: boolean;
  review: boolean;
  waitMin: number;
}

export function watchSettings(p: Profile): WatchSettings {
  const w = p.watch ?? {};
  return {
    enabled: w.enabled ?? false,
    gsi: w.gsi ?? true,
    // GSI over the internet is untested, so polling is on by default in the cloud.
    pollMin: w.pollMin ?? 5,
    parse: w.parse ?? true,
    review: w.review ?? true,
    waitMin: w.waitMin ?? 15,
  };
}

export interface Job {
  matchId: number;
  accountId: number;
  hero?: string;
  via: "GSI" | "poll" | "dashboard";
  state: "parse" | "review" | "reviewing";
  queuedAt: number;
  /** Don't look at this job again before this time. */
  nextAt: number;
  /** Give up waiting for the parse after this time and review what there is. */
  parseDeadline: number;
  parseJob?: number | null;
  attempts: number;
  claimedAt?: number;
}

const MIN = 60_000;
/** A review that has not finished after this long is treated as crashed and retried. */
const CLAIM_TIMEOUT = 15 * MIN;
const MAX_ATTEMPTS = 2;

export class CloudWatcher {
  constructor(
    private db: D1Store,
    private env: { ANTHROPIC_API_KEY?: string; DOTACOACH_MODEL?: string; DOTACOACH_EFFORT?: string },
  ) {}

  // ---------- profile ----------

  async profile(): Promise<Profile> {
    const raw = await this.db.get("profile");
    const p = raw ? (JSON.parse(raw) as Partial<Profile>) : {};
    return { ...p, alts: p.alts ?? [] };
  }

  async saveProfile(p: Profile): Promise<void> {
    await this.db.put("profile", JSON.stringify(p));
  }

  // ---------- log ----------

  async log(text: string): Promise<void> {
    const at = Date.now();
    // Newest first in key order, so the dashboard reads the latest lines with one LIMIT query.
    const key = `log:${String(9_999_999_999_999 - at).padStart(13, "0")}-${Math.random().toString(36).slice(2, 6)}`;
    await this.db.put(key, JSON.stringify({ at, text: text.slice(0, 2000) }), { ttlSec: 7 * 86_400 });
  }

  async logLines(limit = 50): Promise<{ at: number; text: string }[]> {
    const rows = await this.db.entries("log:", limit);
    return rows.map((r) => JSON.parse(r.value) as { at: number; text: string }).reverse();
  }

  // ---------- seen matches ----------

  private async seen(): Promise<number[]> {
    const raw = await this.db.get("seen");
    return raw ? (JSON.parse(raw) as number[]) : [];
  }

  private async markSeen(ids: number[]): Promise<void> {
    const seen = await this.seen();
    const next = [...seen.filter((id) => !ids.includes(id)), ...ids].slice(-500);
    await this.db.put("seen", JSON.stringify(next));
  }

  // ---------- jobs ----------

  async jobs(): Promise<Job[]> {
    const rows = await this.db.entries("job:", 100);
    return rows.map((r) => JSON.parse(r.value) as Job).sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Queue the after-match steps. `force` reviews a match again even if it was seen before. */
  async enqueue(f: { matchId: number; accountId: number; hero?: string; via: Job["via"] }, force = false): Promise<boolean> {
    if (!force && (await this.seen()).includes(f.matchId)) return false;
    const settings = watchSettings(await this.profile());
    const now = Date.now();
    const job: Job = {
      ...f,
      state: settings.parse ? "parse" : "review",
      queuedAt: now,
      nextAt: now,
      parseDeadline: now + settings.waitMin * MIN,
      attempts: 0,
    };
    const added = await this.db.swap(`job:${f.matchId}`, null, JSON.stringify(job));
    if (!added) return false;
    await this.markSeen([f.matchId]);
    const p = await this.profile();
    const acc = profileAccounts(p).find((a) => a.account_id === f.accountId);
    await this.log(`Match ${f.matchId} queued (via ${f.via})${acc ? ` for ${accountName(acc)}` : ""}${f.hero ? `, ${f.hero}` : ""}.`);
    return true;
  }

  private async update(job: Job, prev: string): Promise<boolean> {
    return this.db.swap(`job:${job.matchId}`, prev, JSON.stringify(job));
  }

  // ---------- GSI ----------

  async onGsi(body: GsiPayload): Promise<void> {
    const accountId =
      Number(body.player?.accountid) || (body.player?.steamid ? steam64ToAccountId(body.player.steamid) : null) || null;
    const gameState = body.map?.game_state ?? null;
    // Dota posts every few seconds during a game; write the "last seen" row at most once a minute.
    const prevRaw = await this.db.get("lastgsi");
    const prev = prevRaw ? (JSON.parse(prevRaw) as { at: number; gameState: string | null }) : null;
    if (!prev || prev.gameState !== gameState || Date.now() - prev.at > MIN) {
      await this.db.put("lastgsi", JSON.stringify({ at: Date.now(), gameState, accountId }));
    }

    const matchId = Number(body.map?.matchid);
    if (body.provider?.appid !== 570 || gameState !== "DOTA_GAMERULES_STATE_POST_GAME" || !(matchId > 0)) return;
    if (body.map?.customgamename || !accountId) return;
    const p = await this.profile();
    const settings = watchSettings(p);
    if (!settings.enabled || !settings.gsi) return;
    const mine = new Set(profileAccounts(p).map((a) => a.account_id));
    if (mine.size && !mine.has(accountId)) {
      if (!(await this.seen()).includes(matchId)) {
        await this.markSeen([matchId]);
        await this.log(`Match ${matchId} ended on account ${accountId}, which is not in the profile. Add it as an alt to get reviews.`);
      }
      return;
    }
    const hero = body.hero?.id ? await heroName(body.hero.id).catch(() => undefined) : undefined;
    await this.enqueue({ matchId, accountId, hero, via: "GSI" });
  }

  // ---------- cron ----------

  /** One cron run: poll OpenDota if due, move parse jobs along, and write at most one review. */
  async tick(): Promise<void> {
    const p = await this.profile();
    const s = watchSettings(p);
    if (s.enabled && s.pollMin > 0) await this.pollIfDue(p, s);

    const now = Date.now();
    for (const job of await this.jobs()) {
      const prev = JSON.stringify(job);
      if (job.state === "reviewing") {
        if (now - (job.claimedAt ?? 0) > CLAIM_TIMEOUT) {
          await this.update({ ...job, state: "review", nextAt: now }, prev);
          await this.log(`Match ${job.matchId}: the last review attempt did not finish; retrying.`);
        }
        continue;
      }
      if (job.nextAt > now) continue;
      if (job.state === "parse") {
        await this.advanceParse(job, prev, s);
        continue;
      }
      // state "review": claim it so an overlapping cron run doesn't write the same review.
      const claimed = { ...job, state: "reviewing" as const, claimedAt: now, attempts: job.attempts + 1 };
      if (!(await this.update(claimed, prev))) continue;
      await this.runReview(claimed, p, s);
      return; // one review per run keeps each run inside the CPU and subrequest limits
    }
    if (Math.random() < 0.02) await this.db.purgeExpired();
  }

  private async pollIfDue(p: Profile, s: WatchSettings): Promise<void> {
    const last = Number((await this.db.get("lastpoll")) ?? 0);
    if (Date.now() - last < s.pollMin * MIN - 20_000) return;
    await this.db.put("lastpoll", String(Date.now()));
    const firstRun = last === 0;
    const seen = new Set(await this.seen());
    const found: number[] = [];
    for (const a of profileAccounts(p)) {
      try {
        const [m] = await getPlayerMatches(a.account_id, 1, 0);
        if (!m || seen.has(m.match_id)) continue;
        // The first poll only remembers the latest match instead of reviewing an old game.
        if (firstRun) found.push(m.match_id);
        else await this.enqueue({ matchId: m.match_id, accountId: a.account_id, hero: await heroName(m.hero_id), via: "poll" });
      } catch (err) {
        await this.log(`poll ${a.account_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (found.length) await this.markSeen(found);
  }

  private async advanceParse(job: Job, prev: string, s: WatchSettings): Promise<void> {
    const now = Date.now();
    const next = (patch: Partial<Job>) => this.update({ ...job, ...patch }, prev);
    try {
      if (await matchParsed(job.matchId)) {
        await this.log(`Match ${job.matchId}: replay parsed.`);
        return void (s.review ? await next({ state: "review", nextAt: now }) : await this.finish(job, "parsed; reviews are off"));
      }
      if (now > job.parseDeadline) {
        await this.log(`Match ${job.matchId}: not parsed after ${s.waitMin} min; reviewing with end-of-game data only.`);
        return void (s.review ? await next({ state: "review", nextAt: now }) : await this.finish(job, "not parsed; reviews are off"));
      }
      if (job.parseJob && (await parseJobPending(job.parseJob).catch(() => true))) return void (await next({ nextAt: now + MIN }));
      // No parse job yet, or it ended without a parse (replay not available yet): ask (again).
      const parseJob = await requestParse(job.matchId).catch(() => null);
      if (parseJob && !job.parseJob) await this.log(`Match ${job.matchId}: OpenDota parse job ${parseJob} queued (usually 2-10 min).`);
      await next({ parseJob: parseJob ?? job.parseJob ?? null, nextAt: now + MIN });
    } catch (err) {
      await this.log(`Match ${job.matchId}: ${err instanceof Error ? err.message : String(err)}`);
      await next({ nextAt: now + 2 * MIN });
    }
  }

  private async runReview(job: Job, p: Profile, s: WatchSettings): Promise<void> {
    const prev = JSON.stringify(job);
    if (!s.review) return this.finish(job, "reviews are off");
    if (!this.env.ANTHROPIC_API_KEY) {
      return this.finish(job, "no ANTHROPIC_API_KEY secret is set on the Worker (npx wrangler secret put ANTHROPIC_API_KEY)");
    }
    await this.log(`Match ${job.matchId}: writing the review with Claude...`);
    try {
      const r = await reviewMatch(
        { matchId: job.matchId, accountId: job.accountId, hero: job.hero, profile: p },
        { apiKey: this.env.ANTHROPIC_API_KEY, model: this.env.DOTACOACH_MODEL || undefined, effort: this.env.DOTACOACH_EFFORT || undefined },
      );
      await saveReview(job.matchId, `# Match ${job.matchId}\n\n${r.markdown.trim()}\n`);
      const tokens = `${r.usage.input + r.usage.cacheRead + r.usage.cacheWrite} input / ${r.usage.output} output tokens`;
      await this.finish(job, `review saved (${r.model}, ${tokens}${r.marks ? `, ${r.marks} map marks` : ""})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (job.attempts >= MAX_ATTEMPTS) return this.finish(job, `review failed: ${msg}`);
      await this.log(`Match ${job.matchId}: review failed (${msg}); retrying in 2 min.`);
      await this.update({ ...job, state: "review", nextAt: Date.now() + 2 * MIN }, prev);
    }
  }

  private async finish(job: Job, outcome: string): Promise<void> {
    await this.db.delete(`job:${job.matchId}`);
    await this.log(`Match ${job.matchId}: ${outcome}.`);
  }
}

export interface GsiPayload {
  provider?: { appid?: number };
  map?: { matchid?: string; game_state?: string; customgamename?: string };
  player?: { accountid?: string | number; steamid?: string };
  hero?: { id?: number };
  auth?: { token?: string };
}
