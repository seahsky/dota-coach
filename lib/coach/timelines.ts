import { heroName } from "../heroes.ts";
import { itemMap } from "../items.ts";
import { fetchMatch } from "../match.ts";

/** Fields of a parsed match that lib/types.ts does not declare. */
interface TimelinePlayer {
  hero_id: number;
  isRadiant: boolean;
  position_est?: number | null;
  lane_role?: number | null;
  gold_t?: number[];
  lh_t?: number[];
  dn_t?: number[];
  xp_t?: number[];
  deaths_log?: { time: number }[];
  first_purchase_time?: Record<string, number>;
  benchmarks?: Record<string, { pct?: number | null }>;
}

const mm = (s: number) => `${s < 0 ? "-" : ""}${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;

/**
 * The timelines GetMatch does not print: objectives, teamfights, each player's numbers at
 * 10:00, big-item purchase times and OpenDota percentiles. Parsed matches only.
 */
export async function matchTimelines(matchId: string | number): Promise<string> {
  const { match: m } = await fetchMatch(String(matchId));
  if (m.version == null) return "Replay not parsed: no objectives, teamfights, lane numbers or purchase times.\n";
  const items = new Map([...(await itemMap()).values()].map((i) => [i.key, i]));
  const out: string[] = ["## Objectives (team 2 = Radiant, 3 = Dire; badguys = Dire building)"];
  for (const o of m.objectives ?? []) out.push([mm(o.time), o.type, o.key ?? "", o.team ?? "", o.unit ?? ""].join(" ").trim());
  out.push("", "## Teamfights (start-end, deaths)");
  for (const t of (m.teamfights ?? []) as { start: number; end: number; deaths: number }[]) {
    out.push(`${mm(t.start)}-${mm(t.end)} deaths ${t.deaths}`);
  }
  out.push("", "## Players at 10:00 and item timings (cost >= 1000)");
  for (const p of m.players as unknown as TimelinePlayer[]) {
    const at = (a: number[] | undefined, i: number) => a?.[Math.min(i, a.length - 1)] ?? "?";
    const big = Object.entries(p.first_purchase_time ?? {})
      .filter(([k]) => (items.get(k)?.cost ?? 0) >= 1000)
      .sort((a, b) => a[1] - b[1])
      .map(([k, t]) => `${items.get(k)!.name} ${mm(t)}`);
    const b = p.benchmarks ?? {};
    const pc = (k: string) => (b[k]?.pct == null ? "?" : Math.round(b[k]!.pct! * 100));
    const early = (p.deaths_log ?? []).filter((d) => d.time < 600).length;
    out.push(
      `${p.isRadiant ? "R" : "D"} ${await heroName(p.hero_id)} pos ${p.position_est ?? "?"} lane ${p.lane_role ?? "?"} | ` +
        `10min gold ${at(p.gold_t, 10)} lh ${at(p.lh_t, 10)} dn ${at(p.dn_t, 10)} xp ${at(p.xp_t, 10)} | deaths before 10:00 ${early} | ` +
        `pctile gpm ${pc("gold_per_min")} lh/min ${pc("last_hits_per_min")} deaths ${pc("deaths_per_min")}`,
      `   ${big.join(", ") || "no purchase log"}`,
    );
  }
  return out.join("\n") + "\n";
}
