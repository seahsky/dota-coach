import { store } from "./store.ts";

/** Saved post-game reviews: reviews/<id>.md locally, KV keys review:<id> in the Worker. */

export async function saveReview(matchId: number, markdown: string): Promise<void> {
  await (await store()).put(`review:${matchId}`, markdown);
}

export async function readReview(matchId: number | string): Promise<string | null> {
  return (await store()).get(`review:${matchId}`);
}

export async function listReviews(): Promise<{ matchId: number; savedAt: number }[]> {
  const keys = await (await store()).list("review:");
  return keys
    .map((k) => ({ matchId: Number(k.key.slice("review:".length)), savedAt: k.updatedAt ?? 0 }))
    .filter((r) => Number.isInteger(r.matchId) && r.matchId > 0)
    .sort((a, b) => b.savedAt - a.savedAt || b.matchId - a.matchId);
}
