import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

/**
 * File backend for lib/store.ts. Reviews and map marks keep the paths they always had
 * (reviews/<id>.md, reviews/<id>.map.json) so existing reviews still show up.
 */
export const REVIEWS_DIR = join(import.meta.dir, "..", "reviews");
const STATE_DIR = join(REVIEWS_DIR, ".state");

function pathFor(key: string): string {
  const review = key.match(/^review:(\d{1,20})$/);
  if (review) return join(REVIEWS_DIR, `${review[1]}.md`);
  const markers = key.match(/^markers:(\d{1,20})$/);
  if (markers) return join(REVIEWS_DIR, `${markers[1]}.map.json`);
  if (!/^[a-z0-9:_-]{1,100}$/i.test(key)) throw new Error(`Invalid store key "${key}"`);
  return join(STATE_DIR, `${key.replace(/:/g, "_")}.json`);
}

export const fileStore: Store = {
  async get(key) {
    try {
      return readFileSync(pathFor(key), "utf8");
    } catch {
      return null;
    }
  },
  async put(key, value) {
    const file = pathFor(key);
    mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, value);
    renameSync(tmp, file);
  },
  async delete(key) {
    rmSync(pathFor(key), { force: true });
  },
  async list(prefix) {
    const kind = prefix === "review:" ? ".md" : prefix === "markers:" ? ".map.json" : null;
    if (!kind) throw new Error(`The file store can only list "review:" and "markers:" (got "${prefix}")`);
    try {
      return readdirSync(REVIEWS_DIR)
        .map((f) => f.match(kind === ".md" ? /^(\d+)\.md$/ : /^(\d+)\.map\.json$/)?.[1])
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ key: `${prefix}${id}`, updatedAt: statSync(pathFor(`${prefix}${id}`)).mtimeMs }));
    } catch {
      return [];
    }
  },
};
