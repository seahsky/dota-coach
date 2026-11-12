import "./env.ts";

export const HOUR = 3600_000;

/** TTLs per endpoint class, in ms. `Infinity` never expires. */
export const TTL = {
  constants: 24 * HOUR,
  stats: 6 * HOUR,
  patch: 6 * HOUR,
  match: Infinity,
} as const;

export interface CacheEntry<T = unknown> {
  key: string;
  fetchedAt: number;
  data: T;
}

/** Storage for the API cache: files locally (lib/cache-file.ts), Workers KV in the Cloudflare Worker. */
export interface CacheBackend {
  read(key: string): Promise<CacheEntry | null>;
  write(entry: CacheEntry): Promise<void>;
}

let backend: CacheBackend | null = null;

export function setCacheBackend(b: CacheBackend): void {
  backend = b;
}

async function getBackend(): Promise<CacheBackend> {
  backend ??= (await import("./cache-file.ts")).fileCache;
  return backend;
}

const disabled = () => typeof process !== "undefined" && Boolean(process.env?.DOTACOACH_NO_CACHE);

export async function cacheGet<T>(key: string, ttlMs: number): Promise<{ data: T; fetchedAt: number } | null> {
  if (disabled()) return null;
  try {
    const entry = (await (await getBackend()).read(key)) as CacheEntry<T> | null;
    if (!entry || entry.key !== key) return null;
    if (Date.now() - entry.fetchedAt > ttlMs) return null;
    return { data: entry.data, fetchedAt: entry.fetchedAt };
  } catch {
    return null;
  }
}

/** Read an entry regardless of age. Used as a fallback when the network fails. */
export function cacheGetStale<T>(key: string): Promise<{ data: T; fetchedAt: number } | null> {
  return cacheGet<T>(key, Infinity);
}

export async function cacheSet<T>(key: string, data: T): Promise<void> {
  try {
    await (await getBackend()).write({ key, fetchedAt: Date.now(), data });
  } catch {
    // A read-only or full disk, or a KV write limit, should not break the tool; we just lose caching.
  }
}
