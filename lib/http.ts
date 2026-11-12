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
      "). Wait a minute and retry. Cached results are reused automatically."
    );
  }
  return `${source} rate limit reached (HTTP 429). Wait a minute and retry.`;
}

/**
 * GET a JSON document with file caching. On a network failure, 5xx or 429,
 * falls back to a stale cache entry if one exists and notes that on stderr.
 */
export async function getJson<T>(url: string, opts: FetchOpts): Promise<T> {
  return (await getJsonMeta<T>(url, opts)).data;
}

/** Like getJson, but also says whether the data came from a stale cache entry. */
export async function getJsonMeta<T>(url: string, opts: FetchOpts): Promise<{ data: T; stale: boolean }> {
  if (opts.ttl > 0) {
    const hit = await cacheGet<T>(url, opts.ttl);
    if (hit) return { data: hit.data, stale: false };
  }
  const fresh = (data: T) => ({ data, stale: false });
  const stale = (data: T) => ({ data, stale: true });

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "dotacoach-skill" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const old = await staleOrNull<T>(url, opts.source);
    if (old !== null) return stale(old);
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not connect";
    throw new DotaError(`${opts.source} request ${reason} (${new URL(url).host}). Check your network and retry.`);
  }

  if (res.status === 429) {
    const old = await staleOrNull<T>(url, opts.source, "rate limited");
    if (old !== null) return stale(old);
    throw new RateLimitError(rateLimitMessage(opts.source, res));
  }
  if (res.status === 404) {
    if (opts.allow404) return fresh(null as T);
    throw new NotFoundError(`${opts.what ?? "Resource"} not found on ${opts.source}.`);
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    if (res.status >= 500) {
      const old = await staleOrNull<T>(url, opts.source);
      if (old !== null) return stale(old);
    }
    const what = opts.what ?? new URL(url).pathname;
    const hint = res.status >= 500 ? " Try again later." : "";
    throw new DotaError(`${opts.source} returned HTTP ${res.status} for ${what}${detail ? `: ${detail}` : ""}.${hint}`);
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    throw new DotaError(`${opts.source} returned a response that is not valid JSON.`);
  }
  if (opts.ttl > 0) await cacheSet(url, data);
  return fresh(data);
}

/** Short reason from an error body, e.g. OpenDota explorer's {"err":"Error: Query read timeout"}. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    try {
      const j = JSON.parse(text) as { err?: unknown; error?: unknown; message?: unknown };
      const m = j.err ?? j.error ?? j.message;
      if (typeof m === "string") return m.slice(0, 200);
    } catch {}
    return text.startsWith("<") ? "" : text.slice(0, 200);
  } catch {
    return "";
  }
}

async function staleOrNull<T>(url: string, source: Source, why = "unreachable"): Promise<T | null> {
  const old = await cacheGetStale<T>(url);
  if (!old) return null;
  const age = Math.round((Date.now() - old.fetchedAt) / 3600_000);
  console.error(`Note: ${source} ${why}; using cached data from ${age}h ago.`);
  return old.data;
}

export const opendota = <T>(path: string, opts: Omit<FetchOpts, "source">) =>
  getJson<T>(`${OPENDOTA}${path}`, { ...opts, source: "OpenDota" });

export const valve = <T>(path: string, opts: Omit<FetchOpts, "source">) =>
  getJson<T>(`${VALVE}${path}`, { ...opts, source: "Valve datafeed" });
