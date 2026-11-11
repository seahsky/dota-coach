import { cacheGet, cacheGetStale, cacheSet } from "./cache.ts";
import { DotaError, NotFoundError, RateLimitError } from "./errors.ts";

export const OPENDOTA = "https://api.opendota.com/api";
export const VALVE = "https://www.dota2.com/datafeed";

export type Source = "OpenDota" | "Valve datafeed" | "STRATZ";

export interface FetchOpts {
  /** Cache TTL in ms. 0 disables caching for this call. */
  ttl: number;
  source: Source;
  /** What the user asked for, used in 404 messages (e.g. "Match 123"). */
  what?: string;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
}

const TIMEOUT_MS = 20_000;

function rateLimitMessage(source: Source, res: Response): string {
  if (source === "OpenDota") {
    const min = res.headers.get("x-rate-limit-remaining-minute");
    const day = res.headers.get("x-rate-limit-remaining-day");
    const left = [min && `${min} left this minute`, day && `${day} left today`].filter(Boolean).join(", ");
    return (
      "OpenDota rate limit reached (free tier allows 60 requests/minute and 3,000/day" +
      (left ? `; ${left}` : "") +
      "). Wait a minute and retry. Cached results in ~/.cache/dotacoach are reused automatically."
    );
  }
  return `${source} rate limit reached (HTTP 429). Wait a minute and retry.`;
}

/**
 * GET a JSON document with file caching. On a network failure or 5xx, falls
 * back to a stale cache entry if one exists and notes that on stderr.
 */
export async function getJson<T>(url: string, opts: FetchOpts): Promise<T> {
  if (opts.ttl > 0) {
    const hit = cacheGet<T>(url, opts.ttl);
    if (hit) return hit.data;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "dotacoach-skill" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const stale = staleOrNull<T>(url, opts.source);
    if (stale !== null) return stale;
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not connect";
    throw new DotaError(`${opts.source} request ${reason} (${new URL(url).host}). Check your network and retry.`);
  }

  if (res.status === 429) throw new RateLimitError(rateLimitMessage(opts.source, res));
  if (res.status === 404) {
    if (opts.allow404) return null as T;
    throw new NotFoundError(`${opts.what ?? "Resource"} not found on ${opts.source}.`);
  }
  if (!res.ok) {
    const stale = staleOrNull<T>(url, opts.source);
    if (stale !== null) return stale;
    throw new DotaError(`${opts.source} returned HTTP ${res.status} for ${opts.what ?? new URL(url).pathname}. Try again later.`);
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    throw new DotaError(`${opts.source} returned a response that is not valid JSON.`);
  }
  if (opts.ttl > 0) cacheSet(url, data);
  return data;
}

function staleOrNull<T>(url: string, source: Source): T | null {
  const stale = cacheGetStale<T>(url);
  if (!stale) return null;
  const age = Math.round((Date.now() - stale.fetchedAt) / 3600_000);
  process.stderr.write(`Note: ${source} unreachable; using cached data from ${age}h ago.\n`);
  return stale.data;
}

export const opendota = <T>(path: string, opts: Omit<FetchOpts, "source">) =>
  getJson<T>(`${OPENDOTA}${path}`, { ...opts, source: "OpenDota" });

export const valve = <T>(path: string, opts: Omit<FetchOpts, "source">) =>
  getJson<T>(`${VALVE}${path}`, { ...opts, source: "Valve datafeed" });
