import { heroName } from "./heroes.ts";
import { getPlayer, getPlayerMatches, playerWon, rankName } from "./players.ts";
import { type Account, parseAccountId } from "./profile.ts";

/** Dashboard data shared by the local page (tools/Dashboard.ts) and the Cloudflare Worker. */

export type RoleAccount = Account & { role: "main" | "alt" };

export async function accountsWithRank(accounts: RoleAccount[]) {
  return Promise.all(
    accounts.map(async (a) => {
      try {
        const p = await getPlayer(a.account_id);
        return { ...a, persona: p.profile?.personaname ?? a.persona ?? null, rank: rankName(p.rank_tier, p.leaderboard_rank), error: null };
      } catch (err) {
        return { ...a, persona: a.persona ?? null, rank: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/** Check the account exists on OpenDota before saving it. */
export async function verifyAccount(input: string, label?: string): Promise<Account> {
  const id = parseAccountId(input);
  const p = await getPlayer(id);
  return { account_id: id, ...(label ? { label } : {}), persona: p.profile?.personaname ?? undefined };
}

export async function recentMatches(accounts: RoleAccount[], count: number, reviewed: Set<number>) {
  const per = await Promise.all(
    accounts.map(async (a) => {
      try {
        return { a, matches: await getPlayerMatches(a.account_id, count), error: null };
      } catch (err) {
        return { a, matches: [], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const rows = [];
  for (const { a, matches } of per) {
    for (const m of matches) {
      rows.push({
        matchId: m.match_id,
        accountId: a.account_id,
        account: a.label ?? a.persona ?? String(a.account_id),
        role: a.role,
        hero: await heroName(m.hero_id).catch(() => `Hero ${m.hero_id}`),
        won: playerWon(m),
        kda: `${m.kills}/${m.deaths}/${m.assists}`,
        startTime: m.start_time,
        endTime: m.start_time + m.duration,
        duration: m.duration,
        parsed: Boolean(m.version),
        hasReview: reviewed.has(m.match_id),
      });
    }
  }
  rows.sort((x, y) => y.startTime - x.startTime);
  return { matches: rows.slice(0, count), errors: per.filter((p) => p.error).map((p) => `${p.a.account_id}: ${p.error}`) };
}

export function maskKey(key: string | undefined): string | null {
  const k = key?.trim();
  if (!k) return null;
  return k.length <= 8 ? "set" : `${k.slice(0, 4)}...${k.slice(-4)}`;
}
