import { TTL } from "../lib/cache.ts";
import { intFlag, num, output, parseCli, pct, sourceLine, table } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { heroMap, resolveHero, type Hero } from "../lib/heroes.ts";
import { opendota } from "../lib/http.ts";
import { hasStratzKey, stratzQuery } from "../lib/stratz.ts";
import type { OdMatchup } from "../lib/types.ts";

const USAGE =
  'bun run tools/GetMatchups.ts "<hero>" [--top=8] [--min-games=20] [--vs=<hero>] [--bracket=<herald_guardian|crusader_archon|legend_ancient|divine_immortal|all>] [--json]';

const DEFAULT_MIN_GAMES = 20;
/**
 * Prior strength in games for shrinking deltas toward 0. An empirical-Bayes
 * estimate from OpenDota's pro sample often says the spread is all noise
 * (infinite prior), which would flatten every ranking, so a fixed value is
 * used: 100 games is roughly what a true matchup spread of ~4-5 points implies.
 */
const PRIOR_GAMES = 100;
const Z95 = 1.96;

const BRACKETS = ["HERALD_GUARDIAN", "CRUSADER_ARCHON", "LEGEND_ANCIENT", "DIVINE_IMMORTAL"] as const;
type Bracket = (typeof BRACKETS)[number];

/**
 * odota/core svc/api/spec.ts joins `matches` with start_time in the last 365
 * days; svc/util/insert.ts only writes premium/professional-tier league matches
 * to that table. `wins` counts the queried hero's side winning.
 */
const OPENDOTA_POPULATION =
  "OpenDota pro matches (premium/professional-tier leagues) from the last 365 days";

interface Row {
  heroId: number;
  games: number;
  wins: number;
}

interface Matchup {
  heroId: number;
  hero: string;
  games: number;
  wins: number;
  winrate: number;
  delta: number;
  margin95: number;
  shrunkDelta: number;
  significant: boolean;
}

interface Result {
  source: string;
  fallbackReason: string | null;
  population: string;
  hero: { id: number; name: string };
  heroGames: number;
  baselineWinrate: number;
  minGames: number;
  opponentsTotal: number;
  opponentsShown: number;
  opponentsHidden: number;
  method: string;
  significantCount: number;
  best: Matchup[];
  worst: Matchup[];
  vs: (Matchup & { belowMinGames: boolean }) | null;
  vsMissing: string | null;
}

const METHOD =
  `Ranked by shrunk delta = (winrate - baseline) x games/(games+${PRIOR_GAMES}); ` +
  `deltas in percentage points; +/- is the 95% binomial margin (1.96 x sqrt(p(1-p)/games), p = baseline).`;

interface StratzMatchUp {
  heroStats?: {
    matchUp?: { vs?: { heroId1?: unknown; heroId2?: unknown; matchCount?: unknown; winCount?: unknown }[] }[];
  };
}

/**
 * matchUp rather than heroVsHeroMatchup: its winCount was shown live (2026-09)
 * to be the queried hero's wins. The bracket literal is inlined because public
 * SDLs disagree on the enum type name of the variable.
 */
function stratzMatchUpQuery(bracket: Bracket | null): string {
  const b = bracket ? `, bracketBasicIds: [${bracket}]` : "";
  return `query GetMatchUp($heroId: Short!) {
  heroStats {
    matchUp(heroId: $heroId, take: 200${b}) {
      vs { heroId1 heroId2 matchCount winCount }
    }
  }
}`;
}

const pp = (x: number, signed = false) => `${signed && x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

async function fromStratz(heroId: number, bracket: Bracket | null): Promise<Row[]> {
  const data = await stratzQuery<StratzMatchUp>(stratzMatchUpQuery(bracket), { heroId }, TTL.stats);
  if (!data) throw new DotaError("no STRATZ_API_KEY");
  const groups = data.heroStats?.matchUp;
  if (!Array.isArray(groups)) throw new DotaError("STRATZ response had no heroStats.matchUp list");
  const byHero = new Map<number, Row>();
  for (const g of groups) {
    if (!Array.isArray(g?.vs)) throw new DotaError("STRATZ matchUp entry had no vs list");
    for (const r of g.vs) {
      if (!isNum(r.heroId1) || !isNum(r.heroId2) || !isNum(r.matchCount) || !isNum(r.winCount)) {
        throw new DotaError("STRATZ matchUp row missing heroId1/heroId2/matchCount/winCount");
      }
      if (r.heroId2 === 0 || r.heroId1 === 0) continue; // totals row
      if (r.heroId1 !== heroId) throw new DotaError(`STRATZ row heroId1=${r.heroId1}, expected ${heroId}`);
      if (r.winCount > r.matchCount || r.winCount < 0) throw new DotaError("STRATZ row has winCount outside 0..matchCount");
      const row = byHero.get(r.heroId2) ?? { heroId: r.heroId2, games: 0, wins: 0 };
      row.games += r.matchCount;
      row.wins += r.winCount;
      byHero.set(r.heroId2, row);
    }
  }
  const rows = [...byHero.values()].filter((r) => r.games > 0);
  if (rows.length === 0) throw new DotaError("STRATZ returned no matchup rows");
  return rows;
}

async function fromOpenDota(heroId: number): Promise<Row[]> {
  const raw = await opendota<OdMatchup[]>(`/heroes/${heroId}/matchups`, { ttl: TTL.stats, what: `Hero ${heroId} matchups` });
  // Postgres count()/sum() can arrive as strings; coerce defensively.
  return raw
    .map((r) => ({ heroId: Number(r.hero_id), games: Number(r.games_played), wins: Number(r.wins) }))
    .filter((r) => r.games > 0 && r.heroId !== heroId);
}

function parseBracket(v: unknown): Bracket | null {
  if (v === undefined) return null;
  const up = String(v).toUpperCase().replace(/[^A-Z]+/g, "_");
  if (up === "ALL") return null;
  if ((BRACKETS as readonly string[]).includes(up)) return up as Bracket;
  const pair = BRACKETS.find((b) => b.split("_").includes(up));
  if (pair) return pair;
  throw new DotaError(`--bracket must be one of ${BRACKETS.map((b) => b.toLowerCase()).join(", ")}, all, or a single rank such as divine (got "${v}").`);
}

await main(async () => {
  const args = parseCli(USAGE, { strings: ["top", "min-games", "vs", "bracket"] });
  const input = args.positionals.join(" ").trim();
  if (!input) throw new DotaError(`No hero given.\nUsage: ${USAGE}`);
  const top = intFlag(args.flags.top, "top", 8, 1, 130);
  const minGames = intFlag(args.flags["min-games"], "min-games", DEFAULT_MIN_GAMES, 1, 100_000);
  const bracket = parseBracket(args.flags.bracket);

  const hero = await resolveHero(input);
  const vsHero: Hero | null = typeof args.flags.vs === "string" ? await resolveHero(args.flags.vs) : null;
  if (vsHero?.id === hero.id) throw new DotaError(`--vs names the same hero as the query (${hero.name}).`);

  let rows: Row[] | null = null;
  let source = "OpenDota /heroes/{id}/matchups";
  let population = OPENDOTA_POPULATION;
  let fallbackReason: string | null = null;
  if (hasStratzKey()) {
    try {
      rows = await fromStratz(hero.id, bracket);
      source = "STRATZ heroStats.matchUp";
      population = `STRATZ matchup data, ${bracket ? `bracket ${bracket}` : "no bracket filter sent"}, STRATZ default time window`;
    } catch (err) {
      fallbackReason = `STRATZ failed (${err instanceof Error ? err.message : String(err)}); used OpenDota instead`;
    }
  }
  if (!rows) {
    rows = await fromOpenDota(hero.id);
    if (bracket && !fallbackReason) fallbackReason = "--bracket needs STRATZ_API_KEY; OpenDota has no bracket split, ignored";
    else if (bracket) fallbackReason += "; --bracket ignored";
  }
  if (rows.length === 0) {
    throw new DotaError(`No matchup data for ${hero.name} in ${population}.`);
  }

  const totalGames = rows.reduce((s, r) => s + r.games, 0);
  const baseline = rows.reduce((s, r) => s + r.wins, 0) / totalGames;
  const names = await heroMap();
  const toMatchup = (r: Row): Matchup => {
    const winrate = r.wins / r.games;
    const delta = winrate - baseline;
    const margin95 = Z95 * Math.sqrt((baseline * (1 - baseline)) / r.games);
    return {
      heroId: r.heroId,
      hero: names.get(r.heroId)?.name ?? `Hero #${r.heroId}`,
      games: r.games,
      wins: r.wins,
      winrate,
      delta,
      margin95,
      shrunkDelta: (delta * r.games) / (r.games + PRIOR_GAMES),
      significant: Math.abs(delta) > margin95,
    };
  };

  const eligible = rows.filter((r) => r.games >= minGames).map(toMatchup).sort((a, b) => b.shrunkDelta - a.shrunkDelta);
  // Halves keep one opponent from appearing in both lists; the sign filter keeps a
  // slightly-positive matchup out of "worst" when few opponents qualify.
  const half = Math.ceil(eligible.length / 2);
  const best = eligible.slice(0, Math.min(top, half)).filter((m) => m.shrunkDelta > 0);
  const worst = eligible.slice(half).reverse().slice(0, top).filter((m) => m.shrunkDelta < 0);
  const n = best.length + worst.length;

  let vs: Result["vs"] = null;
  let vsMissing: string | null = null;
  if (vsHero) {
    const r = rows.find((x) => x.heroId === vsHero.id);
    if (r) vs = { ...toMatchup(r), belowMinGames: r.games < minGames };
    else vsMissing = `No games of ${hero.name} against ${vsHero.name} in this sample.`;
  }

  // Each match contributes one row per enemy hero, so OpenDota's total is 5x the hero's matches.
  const heroGames = source.startsWith("OpenDota") ? Math.round(totalGames / 5) : Number.NaN;

  const result: Result = {
    source,
    fallbackReason,
    population,
    hero: { id: hero.id, name: hero.name },
    heroGames: Number.isFinite(heroGames) ? heroGames : 0,
    baselineWinrate: baseline,
    minGames,
    opponentsTotal: rows.length,
    opponentsShown: eligible.length,
    opponentsHidden: rows.length - eligible.length,
    method: METHOD,
    significantCount: eligible.filter((m) => m.significant).length,
    best,
    worst,
    vs,
    vsMissing,
  };

  output(args, result, () => {
    const out: string[] = [`# ${hero.name} matchups`, ""];
    if (fallbackReason) out.push(`Note: ${fallbackReason}.`, "");
    const sampleSize = Number.isFinite(heroGames)
      ? `${num(heroGames)} ${hero.name} matches`
      : `${num(totalGames)} hero-vs-hero games summed over opponents`;
    out.push(
      `Sample: ${population}. ${sampleSize}; baseline ${hero.name} winrate in this sample ${pct(baseline)}.`,
      `Threshold: opponents with fewer than ${num(minGames)} games hidden (${result.opponentsHidden} of ${rows.length}); change with --min-games=N.`,
      METHOD,
    );
    const expected = Math.round(eligible.length * 0.05);
    if (eligible.length > 0) {
      out.push(
        `${result.significantCount} of ${eligible.length} shown matchups differ from baseline by more than the margin (about ${expected} expected by chance alone).`,
      );
    }
    out.push("");

    const headers = ["Opponent", "Games", `${hero.name} WR`, "Delta pp", "+/- pp", "Shrunk pp"];
    const align: ("l" | "r")[] = ["l", "r", "r", "r", "r", "r"];
    const fmt = (m: Matchup) => [
      m.hero,
      num(m.games),
      pct(m.winrate),
      pp(m.delta, true),
      pp(m.margin95),
      pp(m.shrunkDelta, true),
    ];

    if (vsHero) {
      out.push(`## vs ${vsHero.name}`, "");
      if (vs) {
        out.push(table(headers, [fmt(vs)], align));
        if (vs.belowMinGames) out.push("", `Below the --min-games=${minGames} threshold; treat as noise.`);
      } else out.push(vsMissing!);
      out.push("");
    }

    if (n === 0) {
      out.push(`Not enough opponents with ${minGames}+ games to rank. Try a lower --min-games.`, "");
    } else {
      out.push(`## Best matchups (${hero.name} wins more)`, "", best.length ? table(headers, best.map(fmt), align) : "None above baseline.", "");
      out.push(`## Worst matchups (${hero.name} wins less)`, "", worst.length ? table(headers, worst.map(fmt), align) : "None below baseline.", "");
    }
    out.push(sourceLine(source, !hasStratzKey() ? "STRATZ_API_KEY unset" : fallbackReason ? "STRATZ fallback" : undefined));
    return out.join("\n");
  });
});
