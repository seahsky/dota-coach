import { TTL } from "../lib/cache.ts";
import { intFlag, num, output, parseCli, pct, sourceLine, table } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { resolveHero } from "../lib/heroes.ts";
import { opendota } from "../lib/http.ts";
import { itemMap, type ItemInfo } from "../lib/items.ts";
import type { OdItem, OdItemPopularity } from "../lib/types.ts";

const USAGE = `bun run tools/GetItemBuilds.ts "<hero>" [--top=8] [--all] [--json]
  <hero>   hero name, nickname or id
  --top=N  rows per phase (1-100, default 8)
  --all    also show recipes and pure components outside the start phase
  --json   structured output`;

type PhaseKey = "start" | "early" | "mid" | "late";

/**
 * Windows and cost floors are copied from getHeroItemPopularity in
 * odota/core svc/util/queries.ts. The published OpenAPI descriptions
 * (700/2000/4000 floors) are out of date and must not be used.
 */
const PHASES: { key: PhaseKey; field: keyof OdItemPopularity; label: string; window: string; cost: string }[] = [
  { key: "start", field: "start_game_items", label: "Start", window: "bought at or before 0:00", cost: "cost <= 600" },
  { key: "early", field: "early_game_items", label: "Early", window: "0:00 to 10:00", cost: "cost >= 500" },
  { key: "mid", field: "mid_game_items", label: "Mid", window: "10:00 to 25:00", cost: "cost >= 1000" },
  { key: "late", field: "late_game_items", label: "Late", window: "25:00 onward", cost: "cost >= 2000" },
];

/** /constants/items carries `abilities`, which the shared OdItem type omits. */
type RawItem = OdItem & { abilities?: unknown[] };

interface ItemRow {
  id: number;
  key: string;
  name: string;
  count: number;
  /** Share of the purchases counted in this phase's table (after filtering). */
  share: number;
  /** count / sampled matches; can exceed 1 when bought more than once per game. */
  perGame: number | null;
  /** Other item ids folded into this row (upgrade levels such as Dagon 2-5). */
  mergedIds?: number[];
  /**
   * Per-level purchase counts for merged rows. Buying an upgrade logs a new
   * purchase of the next level, so one Dagon taken to level 5 counts 5 times.
   */
  levels?: { id: number; level: number; count: number }[];
}

interface PhaseResult {
  phase: PhaseKey;
  window: string;
  costFilter: string;
  totalPurchases: number;
  distinctItems: number;
  hiddenPurchases: number;
  hiddenItems: string[];
  items: ItemRow[];
}

interface Sample {
  matches: number;
  leagueMatches: number;
  from: string;
  to: string;
}

interface Result {
  source: string;
  hero: { id: number; name: string };
  sample: Sample | null;
  sampleNote: string;
  showAll: boolean;
  filterRule: string;
  phases: PhaseResult[];
}

const FILTER_RULE =
  "Outside the start phase, recipes and pure components (items with no recipe of their own, no active or passive ability, that go into another item) are hidden; use --all to show them.";

/**
 * OpenDota's query: the hero's last 100 player_matches rows joined to
 * `matches` with version IS NOT NULL. Re-running it via the explorer gives the
 * real sample size and date range. Best effort: failures just drop the line.
 */
async function fetchSample(heroId: number): Promise<Sample | null> {
  const sql =
    "SELECT count(*) n, min(start_time) mn, max(start_time) mx, " +
    "sum(CASE WHEN leagueid > 0 THEN 1 ELSE 0 END) league_n FROM (" +
    "SELECT matches.start_time, matches.leagueid FROM player_matches JOIN matches USING(match_id) " +
    `WHERE hero_id = ${heroId} AND version IS NOT NULL ORDER BY match_id DESC LIMIT 100) t`;
  try {
    const res = await opendota<{ rows?: { n: unknown; mn: unknown; mx: unknown; league_n: unknown }[] }>(
      `/explorer?sql=${encodeURIComponent(sql)}`,
      { ttl: TTL.stats, what: "Sample query" },
    );
    const row = res.rows?.[0];
    const n = Number(row?.n);
    if (!row || !Number.isFinite(n) || n === 0) return null;
    const day = (t: unknown) => new Date(Number(t) * 1000).toISOString().slice(0, 10);
    return { matches: n, leagueMatches: Number(row.league_n) || 0, from: day(row.mn), to: day(row.mx) };
  } catch {
    return null;
  }
}

function buildComponentSet(raw: Record<string, RawItem>): Set<string> {
  const usedIn = new Set<string>();
  for (const it of Object.values(raw)) for (const c of it.components ?? []) usedIn.add(c);
  const pure = new Set<string>();
  for (const [key, it] of Object.entries(raw)) {
    if (key.startsWith("recipe_")) pure.add(key);
    else if (usedIn.has(key) && !it.components?.length && !it.abilities?.length) pure.add(key);
  }
  return pure;
}

/** "dagon_3" -> "dagon" when the levelled item shares the base item's display name. */
function baseKey(key: string, raw: Record<string, RawItem>): string {
  const m = key.match(/^(.+)_(\d)$/);
  if (m && raw[m[1]!] && raw[m[1]!]!.dname === raw[key]?.dname) return m[1]!;
  return key;
}

function buildPhase(
  phase: (typeof PHASES)[number],
  counts: Record<string, number>,
  items: Map<number, ItemInfo>,
  raw: Record<string, RawItem>,
  pure: Set<string>,
  showAll: boolean,
  top: number,
  sampleN: number | null,
): PhaseResult {
  const byKey = new Map<
    string,
    { id: number; key: string; name: string; count: number; ids: Map<number, { level: number; count: number }> }
  >();
  const hidden = new Map<string, number>();
  let total = 0;
  let hiddenPurchases = 0;

  for (const [idStr, count] of Object.entries(counts)) {
    const id = Number(idStr);
    total += count;
    const info = items.get(id);
    const key = info?.key ?? `#${id}`;
    const name = info?.name ?? `Item #${id}`;
    if (!showAll && phase.key !== "start" && pure.has(key)) {
      hiddenPurchases += count;
      hidden.set(name, (hidden.get(name) ?? 0) + count);
      continue;
    }
    const base = info ? baseKey(key, raw) : key;
    const baseId = raw[base]?.id ?? id;
    const entry = byKey.get(base) ?? { id: baseId, key: base, name, count: 0, ids: new Map() };
    entry.count += count;
    const level = base === key ? 1 : Number(key.slice(base.length + 1));
    entry.ids.set(id, { level, count: (entry.ids.get(id)?.count ?? 0) + count });
    byKey.set(base, entry);
  }

  const shown = total - hiddenPurchases;
  const rows = [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, top)
    .map((e): ItemRow => {
      const merged = [...e.ids.keys()].filter((i) => i !== e.id);
      const levels = [...e.ids.entries()]
        .map(([id, v]) => ({ id, level: v.level, count: v.count }))
        .sort((a, b) => a.level - b.level);
      return {
        id: e.id,
        key: e.key,
        name: e.name,
        count: e.count,
        share: shown > 0 ? e.count / shown : 0,
        perGame: sampleN ? e.count / sampleN : null,
        ...(merged.length ? { mergedIds: merged, levels } : {}),
      };
    });

  return {
    phase: phase.key,
    window: phase.window,
    costFilter: phase.cost,
    totalPurchases: total,
    distinctItems: byKey.size,
    hiddenPurchases,
    hiddenItems: [...hidden.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
    items: rows,
  };
}

function render(r: Result): string {
  const out: string[] = [`## ${r.hero.name}: popular items by phase`, ""];
  if (r.sample) {
    const league = r.sample.leagueMatches === r.sample.matches ? "league" : `(${r.sample.leagueMatches} league)`;
    out.push(
      r.sample.leagueMatches === r.sample.matches
        ? `Sample: ${r.sample.matches} most recent parsed ${league} matches, ${r.sample.from} to ${r.sample.to}.`
        : `Sample: ${r.sample.matches} most recent parsed matches ${league}, ${r.sample.from} to ${r.sample.to}.`,
    );
    const days = (Date.parse(r.sample.to) - Date.parse(r.sample.from)) / 86_400_000;
    if (days > 60) out.push(`The sample covers ${Math.round(days)} days, so older games may be from earlier patches.`);
  } else {
    out.push(r.sampleNote);
  }
  out.push("Counts are purchases, so an item bought twice in one game counts twice.", "");

  for (const p of r.phases) {
    const meta = PHASES.find((x) => x.key === p.phase)!;
    out.push(`### ${meta.label} (${p.window}, ${p.costFilter})`);
    if (p.totalPurchases === 0) {
      out.push("No purchases recorded.", "");
      continue;
    }
    const headers = ["Item", "Count", "Share", ...(r.sample ? ["Per game"] : [])];
    const rows = p.items.map((i) => [
      i.mergedIds ? `${i.name} (all levels)` : i.name,
      num(i.count),
      i.share > 0 && i.share < 0.005 ? "<1%" : pct(i.share, 0),
      ...(i.perGame !== null ? [i.perGame.toFixed(2)] : []),
    ]);
    out.push(table(headers, rows, ["l", "r", "r", "r"]));
    const notes = [`${num(p.totalPurchases)} purchases of ${p.distinctItems + p.hiddenItems.length} items`];
    if (p.hiddenPurchases > 0) {
      const names = p.hiddenItems.slice(0, 4).join(", ") + (p.hiddenItems.length > 4 ? ", ..." : "");
      notes.push(`${num(p.hiddenPurchases)} component purchases hidden (${names})`);
    }
    out.push(`_${notes.join("; ")}._`);
    for (const i of p.items.filter((x) => x.levels)) {
      const parts = i.levels!.map((l) => `L${l.level} ${num(l.count)}`).join(", ");
      out.push(`_${i.name} (all levels) adds up purchases of each level, and every upgrade is a purchase: ${parts}._`);
    }
    out.push("");
  }

  if (!r.showAll) out.push(`_${FILTER_RULE} Share is of the purchases shown in that phase._`);
  out.push(
    sourceLine(r.source, `${r.sample ? "sample size from OpenDota /explorer · " : ""}item names from OpenDota constants`),
  );
  return out.join("\n");
}

export async function run(argv: string[]): Promise<string> {
  const args = parseCli(USAGE, { strings: ["top"], booleans: ["all"] }, argv);
  const query = args.positionals.join(" ").trim();
  if (!query) throw new DotaError(`Give a hero name.\nUsage: ${USAGE}`);
  const top = intFlag(args.flags.top, "top", 8, 1, 100);
  const showAll = Boolean(args.flags.all);

  const hero = await resolveHero(query);
  const [pop, items, raw, sample] = await Promise.all([
    opendota<OdItemPopularity>(`/heroes/${hero.id}/itemPopularity`, { ttl: TTL.stats, what: `Hero ${hero.name}` }),
    itemMap(),
    opendota<Record<string, RawItem>>("/constants/items", { ttl: TTL.constants }),
    fetchSample(hero.id),
  ]);
  const pure = buildComponentSet(raw);

  const phases = PHASES.map((p) =>
    buildPhase(p, pop[p.field] ?? {}, items, raw, pure, showAll, top, sample?.matches ?? null),
  );
  if (phases.every((p) => p.totalPurchases === 0)) {
    throw new DotaError(`OpenDota has no recent item purchase data for ${hero.name}.`);
  }

  const result: Result = {
    source: "OpenDota /heroes/{id}/itemPopularity",
    hero: { id: hero.id, name: hero.name },
    sample,
    sampleNote: sample
      ? "Up to the hero's 100 most recent parsed matches in OpenDota's match table (OpenDota describes them as professional games)."
      : "Sample: up to the hero's 100 most recent parsed matches in OpenDota's match table (exact count unavailable).",
    showAll,
    filterRule: showAll ? "none (--all)" : FILTER_RULE,
    phases,
  };
  return output(args, result, () => render(result));
}

if (import.meta.main) await main(() => run(Bun.argv.slice(2)));
