/**
 * Where DotaCoach keeps state that is not the API cache: saved reviews, coach map marks and,
 * in the Cloudflare Worker, the profile and watcher state. Locally (Bun) this is files in the
 * skill folder; the Worker swaps in a Workers KV namespace with setStore() before anything runs.
 *
 * Keys are flat strings ("review:123", "markers:123", "profile"). Values are strings.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`, with a last-modified time in ms when the backend knows it. */
  list(prefix: string): Promise<{ key: string; updatedAt: number | null }[]>;
}

let current: Store | null = null;

export function setStore(s: Store): void {
  current = s;
}

export async function store(): Promise<Store> {
  // Imported lazily so the Worker bundle never evaluates the file backend (node:fs, import.meta.dir).
  current ??= (await import("./store-file.ts")).fileStore;
  return current;
}
