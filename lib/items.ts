import { TTL } from "./cache.ts";
import { opendota } from "./http.ts";
import type { OdItem, OdItemIds } from "./types.ts";

export interface ItemInfo {
  id: number;
  key: string; // internal name without "item_"
  name: string;
  cost: number | null;
  qual?: string;
}

let itemsPromise: Promise<Map<number, ItemInfo>> | null = null;

/** Item id -> info, from OpenDota constants (cached 24h). */
export function itemMap(): Promise<Map<number, ItemInfo>> {
  itemsPromise ??= Promise.all([
    opendota<OdItemIds>("/constants/item_ids", { ttl: TTL.constants }),
    opendota<Record<string, OdItem>>("/constants/items", { ttl: TTL.constants }),
  ]).then(([ids, items]) => {
    const map = new Map<number, ItemInfo>();
    for (const [id, key] of Object.entries(ids)) {
      const it = items[key];
      map.set(Number(id), {
        id: Number(id),
        key,
        name: it?.dname ?? key.replace(/_/g, " "),
        cost: it?.cost ?? null,
        qual: it?.qual,
      });
    }
    return map;
  });
  return itemsPromise;
}

export async function itemName(id: number): Promise<string> {
  return (await itemMap()).get(id)?.name ?? `Item #${id}`;
}
