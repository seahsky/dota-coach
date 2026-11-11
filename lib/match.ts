import { HOUR, TTL, cacheGet, cacheSet } from "./cache.ts";
import { NotFoundError, RateLimitError } from "./errors.ts";
import { OPENDOTA, getJsonMeta } from "./http.ts";
import type { OdMatch, OdMatchPlayer } from "./types.ts";

// Unparsed matches are re-fetched after this so a parse done later (on opendota.com) shows up.
const UNPARSED_TTL = 1 * HOUR;

/** Fields seen on live /matches responses that lib/types.ts does not declare. */
export interface ExtraUnit {
  unitname: string;
  item_0?: number;
  item_1?: number;
  item_2?: number;
  item_3?: number;
  item_4?: number;
  item_5?: number;
  item_neutral?: number;
  item_neutral2?: number;
}
export interface Player extends OdMatchPlayer {
  item_neutral2?: number; // neutral enchantment (e.g. "Greedy")
  team_number?: number;
  leaver_status?: number;
  // Lone Druid's Spirit Bear inventory lives here, not in the hero's item slots.
  additional_units?: ExtraUnit[] | null;
}
export interface Match extends Omit<OdMatch, "players"> {
  players: Player[];
  human_players?: number;
  od_data?: { has_parsed?: boolean } | null;
}

/** Fetch a match; parsed matches are cached forever, unparsed ones for an hour. */
export async function fetchMatch(id: string): Promise<{ match: Match; cache: string }> {
  const url = `${OPENDOTA}/matches/${id}`;
  const hit = cacheGet<Match>(url, TTL.match);
  if (hit) {
    const age = Date.now() - hit.fetchedAt;
    if (hit.data.version != null) return { match: hit.data, cache: "cached (parsed matches are kept forever)" };
    if (age < UNPARSED_TTL) return { match: hit.data, cache: `cached ${Math.round(age / 60_000)}m ago (unparsed, refreshed after 1h)` };
  }
  // ttl 0 so getJson neither reads nor writes the cache; we decide below based on parse state.
  let match: Match;
  try {
    const r = await getJsonMeta<Match>(url, { ttl: 0, source: "OpenDota", what: `Match ${id}` });
    if (r.stale) {
      // Not re-stamped: the next run should still try a refresh.
      const age = hit ? Math.round((Date.now() - hit.fetchedAt) / 3600_000) : 0;
      return { match: r.data, cache: `stale cache from ${age}h ago (OpenDota unavailable)` };
    }
    match = r.data;
  } catch (err) {
    if (hit && err instanceof RateLimitError) {
      const age = Math.round((Date.now() - hit.fetchedAt) / 60_000);
      return { match: hit.data, cache: `cached ${age}m ago (unparsed; refresh skipped, OpenDota rate limit reached)` };
    }
    if (err instanceof NotFoundError) {
      throw new NotFoundError(
        `Match ${id} not found on OpenDota. Check the id. A match that just ended may not be available yet, and some (e.g. private lobbies) may never be.`,
      );
    }
    throw err;
  }
  cacheSet(url, match);
  return { match, cache: match.version != null ? "fetched, cached forever (parsed)" : "fetched, cached 1h (unparsed)" };
}
