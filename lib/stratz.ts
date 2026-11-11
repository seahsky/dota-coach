import { cacheGet, cacheSet } from "./cache.ts";
import { DotaError } from "./errors.ts";

export const STRATZ_URL = "https://api.stratz.com/graphql";

export class StratzError extends DotaError {}

export const hasStratzKey = () => Boolean(process.env.STRATZ_API_KEY?.trim());

/**
 * Run a STRATZ GraphQL query. Returns null when STRATZ_API_KEY is unset so
 * callers can fall back to OpenDota. Throws StratzError on any failure; callers
 * should catch it, fall back, and report the reason.
 *
 * Verified 2026-11-11: without `User-Agent: STRATZ_API` Cloudflare serves an
 * HTML challenge; with it and no token the API answers 403 JSON
 * "A bearer token is required". Response bodies with a key were NOT verified.
 */
export async function stratzQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  ttlMs: number,
): Promise<T | null> {
  const key = process.env.STRATZ_API_KEY?.trim();
  if (!key) return null;

  const cacheKey = `stratz:${query}:${JSON.stringify(variables)}`;
  const hit = cacheGet<T>(cacheKey, ttlMs);
  if (hit) return hit.data;

  let res: Response;
  try {
    res = await fetch(STRATZ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "User-Agent": "STRATZ_API",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StratzError("STRATZ unreachable");
  }
  if (res.status === 429) throw new StratzError("STRATZ rate limit reached");
  if (res.status === 401 || res.status === 403) throw new StratzError("STRATZ rejected the API key (HTTP " + res.status + ")");
  if (!res.ok) throw new StratzError(`STRATZ returned HTTP ${res.status}`);

  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = await res.json();
  } catch {
    throw new StratzError("STRATZ returned invalid JSON");
  }
  if (body.errors?.length) throw new StratzError(`STRATZ query error: ${body.errors[0]!.message}`);
  if (!body.data) throw new StratzError("STRATZ returned no data");
  cacheSet(cacheKey, body.data);
  return body.data;
}
