import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CacheBackend, CacheEntry } from "./cache.ts";

export const CACHE_DIR =
  process.env.DOTACOACH_CACHE_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "dotacoach");

function pathFor(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
  return join(CACHE_DIR, `${hash}.json`);
}

export const fileCache: CacheBackend = {
  async read(key) {
    try {
      return JSON.parse(readFileSync(pathFor(key), "utf8")) as CacheEntry;
    } catch {
      return null;
    }
  },
  async write(entry) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = pathFor(entry.key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
  },
};
