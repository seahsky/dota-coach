import { HOUR, cacheSet } from "./cache.ts";
import { DotaError } from "./errors.ts";
import { OPENDOTA, opendota } from "./http.ts";

export interface OdPlayer {
  profile?: { account_id: number; personaname?: string | null; steamid?: string } | null;
  rank_tier?: number | null;
  leaderboard_rank?: number | null;
}

/** GET /players/{id}/matches?significant=0 -> OdPlayerMatch[] (newest first). */
export interface OdPlayerMatch {
  match_id: number;
  player_slot: number;
  radiant_win: boolean;
  hero_id: number;
  start_time: number;
  duration: number;
  game_mode: number;
  lobby_type: number;
  version: number | null; // non-null once the replay is parsed
  kills: number;
  deaths: number;
  assists: number;
  average_rank?: number | null;
  leaver_status?: number;
  party_size?: number | null;
}

const MEDALS = ["Herald", "Guardian", "Crusader", "Archon", "Legend", "Ancient", "Divine", "Immortal"];

/** OpenDota rank_tier: tens digit is the medal (1 Herald .. 8 Immortal), units the star. */
export function rankName(tier: number | null | undefined, leaderboard?: number | null): string | null {
  if (!tier) return null;
  const medal = MEDALS[Math.floor(tier / 10) - 1];
  if (!medal) return null;
  if (medal === "Immortal") return leaderboard ? `Immortal #${leaderboard}` : "Immortal";
  const star = tier % 10;
  return star ? `${medal} ${star}` : medal;
}

export function bracketKey(tier: number | null | undefined): string | null {
  const medal = tier ? MEDALS[Math.floor(tier / 10) - 1] : undefined;
  return medal ? medal.toLowerCase() : null;
}

export async function getPlayer(accountId: number): Promise<OdPlayer> {
  const p = await opendota<OdPlayer | null>(`/players/${accountId}`, {
    ttl: 1 * HOUR,
    what: `Account ${accountId}`,
    allow404: true,
  });
  if (!p?.profile) {
    throw new DotaError(
      `OpenDota has no profile for account ${accountId}. Check the id (Dota: Profile, Friend ID). ` +
        "If it is right, turn on Settings > Options > Social > Expose Public Match Data in Dota, play a match, then log in once at opendota.com.",
    );
  }
  return p;
}

/** Newest matches first, turbo and unranked included. Short cache so a just-finished game shows up. */
export async function getPlayerMatches(accountId: number, limit: number, ttlMs = 2 * 60_000): Promise<OdPlayerMatch[]> {
  return opendota<OdPlayerMatch[]>(`/players/${accountId}/matches?limit=${limit}&significant=0`, {
    ttl: ttlMs,
    what: `Matches for account ${accountId}`,
  });
}

export const isRadiantSlot = (slot: number) => slot < 128;
export const playerWon = (m: { player_slot: number; radiant_win: boolean }) => isRadiantSlot(m.player_slot) === m.radiant_win;

/**
 * Ask OpenDota to fetch and parse a match. Returns the job id, or null if
 * OpenDota does not know the match yet (Valve's API can lag a few minutes).
 */
export async function requestParse(matchId: number): Promise<number | null> {
  const res = await fetch(`${OPENDOTA}/request/${matchId}`, {
    method: "POST",
    headers: { "User-Agent": "dotacoach-skill" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) throw new DotaError("OpenDota rate limit reached while requesting a parse.");
  const body = (await res.json().catch(() => null)) as { job?: { jobId?: number }; error?: string } | null;
  if (body?.job?.jobId) return body.job.jobId;
  if (body?.error && /not found/i.test(body.error)) return null;
  throw new DotaError(`OpenDota parse request failed (HTTP ${res.status}${body?.error ? `: ${body.error}` : ""}).`);
}

/** True while the parse job is queued or running. OpenDota returns null once it is gone. */
export async function parseJobPending(jobId: number): Promise<boolean> {
  const res = await fetch(`${OPENDOTA}/request/${jobId}`, {
    headers: { "User-Agent": "dotacoach-skill" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return true;
  const body = await res.json().catch(() => null);
  return body !== null;
}

/**
 * Fetch the match bypassing the cache and say whether its replay is parsed.
 * A parsed match is written to the cache under GetMatch's key, so GetMatch
 * shows it right away instead of a cached unparsed copy.
 */
export async function matchParsed(matchId: number): Promise<boolean> {
  const url = `${OPENDOTA}/matches/${matchId}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "dotacoach-skill" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return false;
  const m = (await res.json().catch(() => null)) as { version?: number | null } | null;
  if (!m?.version) return false;
  await cacheSet(url, m);
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Request a parse and wait until the match is parsed or `timeoutMs` passes.
 * Retries the request while OpenDota has not seen the match yet.
 * `log` gets one line per state change.
 */
export async function parseAndWait(
  matchId: number,
  timeoutMs: number,
  log: (s: string) => void = () => {},
): Promise<"parsed" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  if (await matchParsed(matchId)) return "parsed";
  let jobId: number | null = null;
  while (Date.now() < deadline) {
    try {
      jobId = await requestParse(matchId);
    } catch (err) {
      log(`parse request failed: ${err instanceof Error ? err.message : String(err)}; retrying`);
    }
    if (jobId) break;
    log("OpenDota does not have the match yet; retrying in 30s");
    await sleep(30_000);
  }
  if (!jobId) return "timeout";
  log(`parse job ${jobId} queued`);
  while (Date.now() < deadline) {
    await sleep(15_000);
    if (await parseJobPending(jobId).catch(() => true)) continue;
    if (await matchParsed(matchId).catch(() => false)) return "parsed";
    // Job finished without a parse (replay not available yet). Ask again.
    log("parse job ended without a parsed replay; requesting again in 60s");
    await sleep(60_000);
    jobId = (await requestParse(matchId).catch(() => null)) ?? jobId;
  }
  return "timeout";
}
