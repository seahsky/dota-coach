import type { D1Database } from "@cloudflare/workers-types";
import type { CacheBackend, CacheEntry } from "../lib/cache.ts";
import type { Store } from "../lib/store.ts";

/** D1's limit is 2,000,000 bytes per row; leave room for the key and the other columns. */
const MAX_VALUE = 1_900_000;
const DAY = 86_400;

/** lib/store.ts on a D1 table (worker/migrations/0001_init.sql). */
export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
      .bind(key, Date.now())
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async put(key: string, value: string, opts: { ttlSec?: number } = {}): Promise<void> {
    if (value.length > MAX_VALUE) throw new Error(`Value for ${key} is too large for D1 (${value.length} characters).`);
    const now = Date.now();
    await this.db
      .prepare("INSERT INTO kv (key, value, updated_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at")
      .bind(key, value, now, opts.ttlSec ? now + opts.ttlSec * 1000 : null)
      .run();
  }

  /** Write only if the current value is still `expected` (null: the key must not exist). True if written. */
  async swap(key: string, expected: string | null, value: string): Promise<boolean> {
    const now = Date.now();
    const r =
      expected === null
        ? await this.db.prepare("INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").bind(key, value, now).run()
        : await this.db.prepare("UPDATE kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?").bind(value, now, key, expected).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.db.prepare("DELETE FROM kv WHERE key >= ? AND key < ?").bind(prefix, prefixEnd(prefix)).run();
  }

  async list(prefix: string, limit = 1000): Promise<{ key: string; updatedAt: number | null }[]> {
    const { results } = await this.db
      .prepare("SELECT key, updated_at FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?")
      .bind(prefix, prefixEnd(prefix), Date.now(), limit)
      .all<{ key: string; updated_at: number }>();
    return results.map((r) => ({ key: r.key, updatedAt: r.updated_at }));
  }

  /** Rows with values, for small prefixes (jobs, log). */
  async entries(prefix: string, limit = 100): Promise<{ key: string; value: string }[]> {
    const { results } = await this.db
      .prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?")
      .bind(prefix, prefixEnd(prefix), Date.now(), limit)
      .all<{ key: string; value: string }>();
    return results;
  }

  async purgeExpired(): Promise<void> {
    await this.db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(Date.now()).run();
  }
}

/** The smallest string greater than every string starting with `prefix`. */
const prefixEnd = (prefix: string) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/**
 * The API cache on D1, with a small in-memory layer for the life of the isolate. Short-lived
 * entries (player match lists, unparsed matches) stay in memory only, which keeps D1 writes low.
 */
export class D1Cache implements CacheBackend {
  private mem = new Map<string, CacheEntry>();

  constructor(private store: D1Store) {}

  async read(key: string): Promise<CacheEntry | null> {
    const hit = this.mem.get(key);
    if (hit) return hit;
    const raw = await this.store.get(`cache:${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    this.remember(entry);
    return entry;
  }

  async write(entry: CacheEntry): Promise<void> {
    this.remember(entry);
    if (/\/players\/\d+\/matches|\/players\/\d+$/.test(entry.key)) return;
    const isMatch = /\/matches\/\d+$/.test(entry.key);
    if (isMatch && (entry.data as { version?: unknown } | null)?.version == null) return;
    const value = JSON.stringify(entry);
    if (value.length > MAX_VALUE) return;
    // Parsed matches never change; everything else is refetched within a day anyway.
    await this.store.put(`cache:${entry.key}`, value, { ttlSec: isMatch ? 60 * DAY : 3 * DAY });
  }

  private remember(entry: CacheEntry): void {
    this.mem.delete(entry.key);
    this.mem.set(entry.key, entry);
    while (this.mem.size > 40) this.mem.delete(this.mem.keys().next().value!);
  }
}
