import "./env.ts";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const HOUR = 3600_000;

/** TTLs per endpoint class, in ms. `Infinity` never expires. */
export const TTL = {
  constants: 24 * HOUR,
  stats: 6 * HOUR,
  patch: 6 * HOUR,
  match: Infinity,
} as const;

export const CACHE_DIR =
  process.env.DOTACOACH_CACHE_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "dotacoach");

interface Entry<T> {
  key: string;
  fetchedAt: number;
  data: T;
}

function pathFor(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
  return join(CACHE_DIR, `${hash}.json`);
}

export function cacheGet<T>(key: string, ttlMs: number): { data: T; fetchedAt: number } | null {
  if (process.env.DOTACOACH_NO_CACHE) return null;
  try {
    const entry = JSON.parse(readFileSync(pathFor(key), "utf8")) as Entry<T>;
    if (entry.key !== key) return null;
    if (Date.now() - entry.fetchedAt > ttlMs) return null;
    return { data: entry.data, fetchedAt: entry.fetchedAt };
  } catch {
    return null;
  }
}

/** Read an entry regardless of age. Used as a fallback when the network fails. */
export function cacheGetStale<T>(key: string): { data: T; fetchedAt: number } | null {
  return cacheGet<T>(key, Infinity);
}

export function cacheSet<T>(key: string, data: T): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = pathFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, fetchedAt: Date.now(), data } satisfies Entry<T>));
    renameSync(tmp, file);
  } catch {
    // A read-only or full disk should not break the tool; we just lose caching.
  }
}
