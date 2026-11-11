import { TTL } from "../lib/cache.ts";
import { intFlag, num, output, parseCli, pct, signedPct, sourceLine, table } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { heroMap } from "../lib/heroes.ts";
import { opendota } from "../lib/http.ts";
import { hasStratzKey, stratzQuery } from "../lib/stratz.ts";
import type { OdHeroStats } from "../lib/types.ts";

const USAGE =
  "bun run tools/GetHeroStats.ts [--bracket=<rank|all|pro|turbo>] [--role=<pos>] [--sort=winrate|pickrate] " +
  "[--top=20] [--min-picks=N] [--asc] [--days=30] [--json]";

const HELP = `${USAGE}

Win rate and pick rate per hero, sorted. Pick rate = picks / matches in the sample.
  --bracket    all (default; OpenDota 'pub' counter), pro, turbo, herald..immortal or 1-8. Case-insensitive.
               OpenDota never fills its Immortal bracket, so divine/immortal/8 read Divine + Immortal together.
  --role       pos1..pos5, 1..5, carry, mid, offlane, soft (pos 4), hard (pos 5). Uses STRATZ when
               STRATZ_API_KEY is set (ranked All Pick, per bracket); otherwise positions estimated from
               OpenDota explorer pro league matches (--bracket not applied). Not available for turbo.
  --sort       winrate (default) or pickrate. Highest first; --asc for lowest first.
  --top        rows to show, 1-200 (default 20).
  --min-picks  hide heroes below N picks (default max(10, 0.5% of sample matches); 0 = off).
  --days       explorer window for --role without STRATZ, 1-120 (default 30).
  --json       structured output.`;

// ---------- Brackets ----------

type BracketKey = "all" | "pro" | "turbo" | "herald" | "guardian" | "crusader" | "archon" | "legend" | "ancient" | "divine" | "immortal";

const RANKS = ["herald", "guardian", "crusader", "archon", "legend", "ancient", "divine", "immortal"] as const;
type Rank = (typeof RANKS)[number];

interface Bracket {
  key: BracketKey;
  label: string;
  /** Prefix of the OpenDota heroStats fields: `${prefix}_pick`, `${prefix}_win`. */
  odPrefix: string;
  /** STRATZ RankBracket enum values; null means "do not pass bracketIds". */
  stratz: string[] | null;
  /** STRATZ keeps Divine and Immortal apart, unlike OpenDota. */
  stratzLabel: string;
}

const BRACKET_ALIASES: Record<string, BracketKey> = {
  all: "all", pub: "all", pubs: "all", public: "all", ranked: "all",
  pro: "pro", pros: "pro", professional: "pro",
  turbo: "turbo",
};

function parseBracket(input: string | undefined): Bracket {
  const q = (input ?? "all").toLowerCase().replace(/[^a-z0-9]/g, "");
  let key: BracketKey | undefined = BRACKET_ALIASES[q];
  if (!key && /^[1-8]$/.test(q)) key = RANKS[Number(q) - 1];
  if (!key && (RANKS as readonly string[]).includes(q)) key = q as Rank;
  if (!key) {
    throw new DotaError(
      `Unknown bracket "${input}". Valid: all, pro, turbo, ${RANKS.join(", ")}, or 1-8 (1 = Herald ... 8 = Immortal).`,
    );
  }
  const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
  if (key === "all") return { key, label: "All public", odPrefix: "pub", stratz: null, stratzLabel: "all brackets" };
  if (key === "pro") return { key, label: "Pro", odPrefix: "pro", stratz: null, stratzLabel: "Pro" };
  if (key === "turbo") return { key, label: "Turbo", odPrefix: "turbo", stratz: null, stratzLabel: "Turbo" };
  const idx = RANKS.indexOf(key);
  // OpenDota bracket 8 is never filled (see BRACKET_NOTE), so Immortal reads bracket 7.
  const odIdx = key === "immortal" ? 7 : idx + 1;
  const label = key === "divine" || key === "immortal" ? "Divine + Immortal" : cap(key);
  return { key, label, odPrefix: String(odIdx), stratz: [key.toUpperCase()], stratzLabel: cap(key) };
}

/**
 * From odota/core svc/counts.ts (updateHeroCounts) and svc/util/utility.ts
 * (averageMedal): the bracket is floor(avg / 10) of the average medal of the
 * players whose rank is known. averageMedal works in stars and Divine 5 and
 * Immortal both map to 39 stars, which converts back to 75, so the average can
 * never reach 80 and bracket 8 is always empty. Immortal games land in 7.
 */
const BRACKET_NOTE =
  "OpenDota buckets a match by the average medal of its ranked players, and that average tops out at Divine 5, " +
  "so its Immortal bracket is always empty and games of Immortal players are counted under Divine.";

// ---------- Roles ----------

const ROLE_ALIASES: Record<string, number> = {
  pos1: 1, "1": 1, p1: 1, carry: 1, safelane: 1, safe: 1, hardcarry: 1,
  pos2: 2, "2": 2, p2: 2, mid: 2, midlane: 2, middle: 2,
  pos3: 3, "3": 3, p3: 3, offlane: 3, off: 3, offlaner: 3,
  pos4: 4, "4": 4, p4: 4, soft: 4, softsupport: 4, roamer: 4,
  pos5: 5, "5": 5, p5: 5, hard: 5, hardsupport: 5,
};
const ROLE_NAMES = ["", "Pos 1 (carry)", "Pos 2 (mid)", "Pos 3 (offlane)", "Pos 4 (soft support)", "Pos 5 (hard support)"];

function parseRole(input: string | undefined): number | null {
  if (input === undefined) return null;
  const q = input.toLowerCase().replace(/[^a-z0-9]/g, "");
  const role = ROLE_ALIASES[q];
  if (!role && q.startsWith("support")) {
    throw new DotaError(`"${input}" is ambiguous. Use soft (pos 4) or hard (pos 5).`);
  }
  if (!role) {
    throw new DotaError(
      `Unknown role "${input}". Valid: pos1..pos5, 1..5, carry, mid, offlane, soft (pos 4), hard (pos 5).`,
    );
  }
  return role;
}

// ---------- Result shape ----------

interface HeroRow {
  id: number;
  name: string;
  picks: number;
  wins: number;
  winrate: number;
  /** picks / matches in the sample. */
  pickrate: number;
  bans?: number;
  /** (picks + bans) / matches; pro only. */
  contestRate?: number;
  /** Winrate over the last 3 complete days minus the first 3 days of the 7-day window; public "all" only. */
  trend?: number;
}

interface Result {
  source: string;
  /** The population the numbers come from, which differs from requestedBracket on the pro-match role fallback. */
  bracket: string;
  requestedBracket: string;
  role: string | null;
  window: string;
  sample: { matches: number; description: string };
  sort: "winrate" | "pickrate";
  order: "desc" | "asc";
  minPicks: number;
  hiddenBelowMinPicks: number;
  notes: string[];
  stratz: { attempted: boolean; used: boolean; fallbackReason: string | null };
  heroes: HeroRow[];
}

interface Sample {
  source: string;
  window: string;
  matches: number;
  description: string;
  rows: Omit<HeroRow, "name">[];
  notes: string[];
}

// ---------- OpenDota /heroStats ----------

/**
 * Every count in /heroStats is the sum of 7 daily redis buckets, oldest first,
 * the last being the current (partial) day: odota/core svc/api/spec.ts,
 * "/heroStats" handler. Each counted match adds a pick for all 10 heroes, so
 * matches = total picks / 10 (checked: wins sum to exactly half of picks).
 */
async function fromHeroStats(bracket: Bracket): Promise<Sample> {
  const stats = await opendota<OdHeroStats[]>("/heroStats", { ttl: TTL.stats });
  const isTurbo = bracket.key === "turbo";
  const pickKey = isTurbo ? "turbo_picks" : `${bracket.odPrefix}_pick`;
  const winKey = isTurbo ? "turbo_wins" : `${bracket.odPrefix}_win`;
  const field = (h: OdHeroStats, k: string) => Number((h as unknown as Record<string, unknown>)[k] ?? 0) || 0;

  const totalPicks = stats.reduce((a, h) => a + field(h, pickKey), 0);
  const matches = totalPicks / 10;
  if (matches < 1) throw new DotaError(`OpenDota has no ${bracket.label} games in its current 7-day window.`);

  const rows = stats.map((h) => {
    const picks = field(h, pickKey);
    const wins = field(h, winKey);
    const row: Omit<HeroRow, "name"> = {
      id: h.id,
      picks,
      wins,
      winrate: picks ? wins / picks : 0,
      pickrate: picks / matches,
    };
    if (bracket.key === "pro") {
      row.bans = h.pro_ban ?? 0;
      row.contestRate = (picks + row.bans) / matches;
    }
    if (bracket.key === "all") row.trend = trendOf(h.pub_pick_trend, h.pub_win_trend);
    return row;
  });

  const notes: string[] = [];
  if (bracket.key === "all") {
    // counts.ts: pro-tier leagues go to "pro", Turbo to "turbo", anything else isSignificant to "pub";
    // isSignificant checks balanced game_mode/lobby_type flags (plus duration), so amateur leagues and practice lobbies count too.
    notes.push(
      "All public = OpenDota's 'pub' counter: every non-Turbo match outside premium/professional leagues with a balanced " +
        "game mode and lobby type (ranked, normal, practice, lower-tier leagues and others). It includes games where no " +
        "player's rank is known, so it is larger than the sum of the rank brackets.",
    );
    notes.push("Trend = win rate change in percentage points: days 4-6 of the window minus days 1-3 (today's partial day excluded).");
  }
  if (bracket.key === "divine" || bracket.key === "immortal") notes.push(BRACKET_NOTE);
  if (bracket.key === "pro") notes.push("Pro = OpenDota's premium and professional tier leagues. Contest = (picks + bans) / matches.");

  return {
    source: "OpenDota /heroStats",
    window: "last 7 days (daily buckets, current day partial)",
    matches,
    description: `${num(Math.round(matches))} matches (${bracket.label})`,
    rows,
    notes,
  };
}

function trendOf(picks: number[] | undefined, wins: number[] | undefined): number | undefined {
  if (!Array.isArray(picks) || !Array.isArray(wins) || picks.length !== 7 || wins.length !== 7) return undefined;
  const wr = (from: number, to: number) => {
    let p = 0;
    let w = 0;
    for (let i = from; i < to; i++) {
      p += picks[i] ?? 0;
      w += wins[i] ?? 0;
    }
    return p ? w / p : NaN;
  };
  // Index 6 is today's partial bucket; compare days 0-2 with 3-5.
  const d = wr(3, 6) - wr(0, 3);
  return Number.isFinite(d) ? d : undefined;
}

// ---------- OpenDota explorer: estimated positions in pro matches ----------

interface ExplorerRow {
  match_id: number;
  player_slot: number;
  hero_id: number;
  win: boolean;
  lane_role: number | null;
  g: string | number | null;
  lh: string | number | null;
  wards: string | number | null;
}

/**
 * Port of estimatePositions (odota/core svc/util/compute.ts), which OpenDota
 * applies to /matches responses as position_est but does not store, so it is
 * recomputed here. JS gold_t[10..12] is Postgres gold_t[11..13]; a shorter array
 * yields NULL there, which skips that team like the original's length check.
 * Filtering on array_length in SQL instead pushed the query past the
 * explorer's 15 s statement timeout.
 */
// Sums instead of averages: same ranking as odota's /3 average, but exact (a rounded average can create false ties).
function positionSql(days: number): string {
  return `SELECT pm.match_id, pm.player_slot, pm.hero_id, (pm.player_slot < 128) = m.radiant_win AS win, pm.lane_role,
 pm.gold_t[11] + pm.gold_t[12] + pm.gold_t[13] AS g,
 pm.lh_t[11] + pm.lh_t[12] + pm.lh_t[13] AS lh,
 (SELECT count(*) FROM unnest(pm.purchase_log) e WHERE e->>'key' IN ('ward_observer', 'ward_sentry') AND (e->>'time')::int <= 720) AS wards
 FROM matches m JOIN player_matches pm USING(match_id)
 WHERE m.start_time >= extract(epoch from now() - interval '${days} days')`;
}

function estimatePositions(rows: ExplorerRow[]): Map<ExplorerRow, number> {
  const out = new Map<ExplorerRow, number>();
  const teams = new Map<string, ExplorerRow[]>();
  for (const r of rows) {
    const k = `${r.match_id}:${r.player_slot < 128 ? "r" : "d"}`;
    const t = teams.get(k);
    if (t) t.push(r);
    else teams.set(k, [r]);
  }
  for (const team of teams.values()) {
    if (team.length !== 5 || team.some((p) => p.lane_role == null || p.g == null || p.lh == null)) continue;
    // odota iterates match.players in slot order, which decides ties in its stable sorts; SQL rows have no order.
    team.sort((a, b) => a.player_slot - b.player_slot);
    const scored = team.map((p) => ({ p, gold: Number(p.g), lh: Number(p.lh), wards: Number(p.wards ?? 0), rank: 0 }));
    for (const key of ["gold", "lh"] as const) {
      const sorted = [...scored].sort((a, b) => b[key] - a[key]);
      for (const s of scored) s.rank += sorted.indexOf(s);
    }
    scored.sort((a, b) => a.rank - b.rank || a.wards - b.wards);
    const assign = (group: typeof scored, wanted: number[], prefer: (lr: number) => number | null) => {
      const taken = new Set<number>();
      const unassigned: typeof scored = [];
      for (const s of group) {
        const want = prefer(s.p.lane_role!);
        if (want != null && wanted.includes(want) && !taken.has(want)) {
          out.set(s.p, want);
          taken.add(want);
        } else unassigned.push(s);
      }
      const remaining = wanted.filter((w) => !taken.has(w));
      unassigned.forEach((s, i) => out.set(s.p, remaining[i]!));
    };
    assign(scored.slice(0, 3), [1, 2, 3], (lr) => (lr >= 1 && lr <= 3 ? lr : null));
    assign(scored.slice(3), [4, 5], (lr) => (lr === 2 || lr === 3 ? 4 : lr === 1 ? 5 : null));
  }
  return out;
}

async function fromExplorerPositions(role: number, days: number): Promise<Sample> {
  let res: { rows?: ExplorerRow[]; err?: string | null };
  try {
    res = await opendota(`/explorer?sql=${encodeURIComponent(positionSql(days))}`, {
      ttl: TTL.stats,
      what: "OpenDota explorer query",
    });
  } catch (err) {
    // getJson hides the body; the explorer answers HTTP 400 {"err":"Error: Query read timeout"} on its 15 s limit.
    if (err instanceof DotaError && /HTTP 400/.test(err.message)) {
      throw new DotaError(
        `OpenDota explorer rejected or timed out on the position query (it has a 15 s limit). Retry, or use a smaller --days (now ${days}).`,
      );
    }
    throw err;
  }
  if (res?.err) throw new DotaError(`OpenDota explorer query failed: ${res.err}`);
  if (!Array.isArray(res?.rows)) throw new DotaError("OpenDota explorer returned an unexpected response.");

  const pos = estimatePositions(res.rows);
  const byHero = new Map<number, { picks: number; wins: number }>();
  let slots = 0;
  const matchIds = new Set<number>();
  for (const [r, p] of pos) {
    matchIds.add(r.match_id);
    if (p !== role) continue;
    slots++;
    const e = byHero.get(r.hero_id) ?? { picks: 0, wins: 0 };
    e.picks++;
    if (r.win) e.wins++;
    byHero.set(r.hero_id, e);
  }
  if (slots === 0) throw new DotaError(`No parsed pro matches with position data in the last ${days} days.`);
  // Two teams per match, so slots / 2 is the number of matches' worth of this position.
  const matches = slots / 2;
  const rows = [...byHero].map(([id, e]) => ({
    id,
    picks: e.picks,
    wins: e.wins,
    winrate: e.wins / e.picks,
    pickrate: e.picks / matches,
  }));
  return {
    source: "OpenDota /explorer (pro league matches, estimated positions)",
    window: `last ${days} days`,
    matches,
    description: `${num(slots)} ${ROLE_NAMES[role]} slots from ${num(matchIds.size)} parsed pro league matches`,
    rows,
    notes: [
      "Positions are estimated, not recorded: OpenDota's position_est method (farm rank by gold and last hits at 10-12 min, " +
        "then lane; early ward purchases break ties), recomputed here from the explorer DB.",
    ],
  };
}

// ---------- STRATZ ----------

interface StratzWinDay {
  heroId: number;
  day: number;
  matchCount: number;
  winCount: number;
}

function stratzRoleQuery(role: number, bracket: Bracket): string {
  // Bracket literals are inlined to sidestep the disputed variable type name.
  const b = bracket.stratz ? `, bracketIds: [${bracket.stratz.join(", ")}]` : "";
  const args = `take: 7${b}, gameModeIds: [ALL_PICK_RANKED]`;
  return `query HeroesMetaPosition {
  heroStats {
    pos: winDay(${args}, positionIds: [POSITION_${role}]) { heroId day matchCount winCount }
  }
}`;
}

function isWinDayRows(x: unknown): x is StratzWinDay[] {
  return (
    Array.isArray(x) &&
    x.every(
      (r) =>
        r && typeof r === "object" &&
        Number.isFinite((r as StratzWinDay).heroId) &&
        Number.isFinite((r as StratzWinDay).matchCount) &&
        Number.isFinite((r as StratzWinDay).winCount),
    )
  );
}

async function fromStratz(role: number, bracket: Bracket): Promise<Sample> {
  const data = await stratzQuery<{ heroStats?: { pos?: unknown } }>(stratzRoleQuery(role, bracket), {}, TTL.stats);
  if (!data) throw new DotaError("STRATZ_API_KEY unset");
  const raw = data.heroStats?.pos;
  if (!isWinDayRows(raw)) throw new DotaError("STRATZ response did not have the expected heroStats.winDay shape");
  const byHero = new Map<number, { picks: number; wins: number }>();
  const days = new Set<number>();
  let slots = 0;
  for (const r of raw) {
    if (!r.heroId) continue;
    days.add(r.day);
    slots += r.matchCount;
    const e = byHero.get(r.heroId) ?? { picks: 0, wins: 0 };
    e.picks += r.matchCount;
    e.wins += r.winCount;
    byHero.set(r.heroId, e);
  }
  if (slots === 0) throw new DotaError("STRATZ returned no games for this position and bracket");
  const matches = slots / 2;
  // Each match has two players at a position, so no hero can exceed matches; if one does, the rows mean something else.
  if ([...byHero.values()].some((e) => e.picks > matches || e.wins > e.picks)) {
    throw new DotaError("STRATZ numbers failed a sanity check (a hero above 100% pick rate or more wins than games)");
  }
  return {
    source: "STRATZ winDay",
    window: days.size === 7 ? "last 7 days" : `last ${days.size} day${days.size === 1 ? "" : "s"} returned (7 requested)`,
    matches,
    description: `${num(slots)} ${ROLE_NAMES[role]} slots in ranked All Pick, ${bracket.stratzLabel}`,
    rows: [...byHero].map(([id, e]) => ({
      id,
      picks: e.picks,
      wins: e.wins,
      winrate: e.picks ? e.wins / e.picks : 0,
      pickrate: e.picks / matches,
    })),
    notes: [],
  };
}

// ---------- Main ----------

await main(async () => {
  const args = parseCli(Bun.argv.includes("--help") ? HELP : USAGE, { strings: ["bracket", "role", "top", "sort", "min-picks", "days"], booleans: ["asc"] });
  if (args.positionals.length) throw new DotaError(`Unexpected argument "${args.positionals[0]}".\nUsage: ${USAGE}`);

  const bracket = parseBracket(args.flags.bracket as string | undefined);
  const role = parseRole(args.flags.role as string | undefined);
  const top = intFlag(args.flags.top, "top", 20, 1, 200);
  const days = intFlag(args.flags.days, "days", 30, 1, 120);
  const sortIn = String(args.flags.sort ?? "winrate").toLowerCase().replace(/[^a-z]/g, "");
  const sort = sortIn === "winrate" || sortIn === "wr" ? "winrate" : sortIn === "pickrate" || sortIn === "pr" || sortIn === "picks" ? "pickrate" : null;
  if (!sort) throw new DotaError(`Unknown --sort "${args.flags.sort}". Valid: winrate, pickrate.`);
  if (args.flags.days !== undefined && role === null) throw new DotaError("--days only applies with --role (the /heroStats window is fixed at 7 days).");

  const notes: string[] = [];
  let sample: Sample;
  let attempted = false;
  let used = false;
  let fallbackReason: string | null = null;

  if (role === null) {
    sample = await fromHeroStats(bracket);
  } else {
    if (bracket.key === "turbo") throw new DotaError("Per-position stats are not available for Turbo. Drop --role or pick another bracket.");
    if (bracket.key === "pro") {
      fallbackReason = hasStratzKey() ? "the STRATZ position query covers ranked pubs, not pro games" : null;
    } else if (!hasStratzKey()) {
      fallbackReason = "STRATZ_API_KEY unset";
    } else {
      attempted = true;
      try {
        sample = await fromStratz(role, bracket);
        used = true;
      } catch (err) {
        fallbackReason = err instanceof Error ? err.message : String(err);
      }
    }
    if (!used) {
      sample = await fromExplorerPositions(role, days);
      if (bracket.key !== "pro") {
        notes.push(
          "OpenDota has no per-position data for public games, so this uses pro league matches only" +
            (args.flags.bracket !== undefined ? `; --bracket=${args.flags.bracket} is not applied.` : ".") +
            (hasStratzKey() ? "" : " Set STRATZ_API_KEY for ranked public stats by position and bracket."),
        );
      }
    }
  }
  sample = sample!;

  const minPicks = intFlag(args.flags["min-picks"], "min-picks", Math.max(10, Math.round(sample.matches * 0.005)), 0, 10_000_000);
  const heroes = await heroMap();
  const eligible = sample.rows.filter((r) => r.picks > 0 && r.picks >= minPicks);
  const hidden = sample.rows.filter((r) => r.picks > 0 && r.picks < minPicks).length;
  const dir = args.flags.asc ? 1 : -1;
  eligible.sort((a, b) => dir * (a[sort] - b[sort]) || b.picks - a.picks);
  const rows: HeroRow[] = eligible.slice(0, top).map((r) => ({ name: heroes.get(r.id)?.name ?? `Hero #${r.id}`, ...r }));

  const dataBracket = used ? bracket.stratzLabel : role === null || bracket.key === "pro" ? bracket.label : "Pro";
  const result: Result = {
    source: sample.source,
    bracket: dataBracket,
    requestedBracket: bracket.label,
    role: role ? ROLE_NAMES[role]! : null,
    window: sample.window,
    sample: { matches: Math.round(sample.matches), description: sample.description },
    sort,
    order: args.flags.asc ? "asc" : "desc",
    minPicks,
    hiddenBelowMinPicks: hidden,
    notes: [...sample.notes, ...notes],
    stratz: { attempted, used, fallbackReason },
    heroes: rows,
  };

  output(args, result, () => {
    const title = `## Hero ${sort === "winrate" ? "winrates" : "pick rates"}: ${role ? `${ROLE_NAMES[role]}, ` : ""}${dataBracket}`;
    const out = [title, ""];
    out.push(`Sample: ${sample.description}, ${sample.window}.`);
    out.push(
      `Sorted by ${sort} (${result.order === "desc" ? "highest" : "lowest"} first). ` +
        (minPicks > 0 ? `Heroes with fewer than ${num(minPicks)} picks hidden (${hidden}).` : "No minimum pick filter."),
    );
    out.push("");
    const isPro = bracket.key === "pro" && role === null;
    const hasTrend = rows.some((r) => r.trend !== undefined);
    const headers = ["#", "Hero", "Win rate", "Pick rate", "Picks"];
    const align: ("l" | "r")[] = ["r", "l", "r", "r", "r"];
    if (isPro) headers.push("Bans", "Contest"), align.push("r", "r");
    if (hasTrend) headers.push("Trend"), align.push("r");
    out.push(
      table(
        headers,
        rows.map((r, i) => {
          const cells: (string | number)[] = [i + 1, r.name, pct(r.winrate), pct(r.pickrate), num(r.picks)];
          if (isPro) cells.push(num(r.bans ?? 0), pct(r.contestRate ?? 0));
          if (hasTrend) cells.push(r.trend === undefined ? "" : signedPct(Math.abs(r.trend) < 0.0005 ? 0 : r.trend));
          return cells;
        }),
        align,
      ),
    );
    if (!rows.length) out.push("", "No heroes meet the minimum pick count. Lower it with --min-picks.");
    if (result.notes.length) out.push("", ...result.notes.map((n) => `- ${n}`));
    out.push("");
    let extra: string | undefined;
    if (role !== null) {
      if (attempted && !used) extra = `STRATZ failed, fell back to OpenDota: ${fallbackReason}`;
      else if (fallbackReason) extra = `STRATZ not used: ${fallbackReason}`;
    }
    out.push(sourceLine(sample.source, extra));
    return out.join("\n");
  });
});
