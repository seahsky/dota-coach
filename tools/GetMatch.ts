import { TTL } from "../lib/cache.ts";
import { duration, num, output, parseCli, sourceLine, table } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { heroName } from "../lib/heroes.ts";
import { opendota } from "../lib/http.ts";
import { itemMap } from "../lib/items.ts";
import { type Match, type Player, fetchMatch } from "../lib/match.ts";
import type { OdPatch } from "../lib/types.ts";

const USAGE = "bun run tools/GetMatch.ts <match_id> [--draft] [--json]";

interface ConstEntry {
  id: number;
  name: string;
}

const LANE_ROLE: Record<number, string> = { 1: "safe", 2: "mid", 3: "off", 4: "jungle" };

interface PlayerRow {
  team: "Radiant" | "Dire";
  hero_id: number;
  hero: string;
  player: string;
  account_id: number | null;
  position_est: number | null;
  lane_role: string | null;
  is_roaming: boolean | null;
  kills: number;
  deaths: number;
  assists: number;
  last_hits: number;
  denies: number;
  gpm: number;
  xpm: number;
  net_worth: number;
  hero_damage: number;
  tower_damage: number;
  items: string[];
  backpack: string[];
  units: { unit: string; items: string[] }[];
  neutral: string | null;
  enchantment: string | null;
  aghanims_scepter_consumed: boolean;
  aghanims_shard: boolean;
}

interface DraftEntry {
  order: number;
  action: "pick" | "ban";
  team: "Radiant" | "Dire";
  team_name: string | null;
  hero_id: number;
  hero: string;
}

interface Result {
  source: string;
  match_id: number;
  url: string;
  parsed: boolean;
  cache: string;
  start_time: string;
  duration: string;
  winner: "Radiant" | "Dire";
  score: { radiant: number; dire: number };
  game_mode: string;
  lobby_type: string;
  patch: string | null;
  league: string | null;
  teams: { radiant: string | null; dire: string | null };
  first_blood: string | null;
  advantage: { minute: number; last: boolean; gold: number; xp: number | null }[] | null;
  missing_unparsed: string[];
  players: PlayerRow[];
  draft?: {
    available: boolean;
    entries: DraftEntry[];
    note: string | null;
    unrecorded: { team: "Radiant" | "Dire"; hero: string }[];
    heroes?: { radiant: string[]; dire: string[] };
  };
}

const prettyConst = (name: string | undefined, prefix: string) =>
  name ? name.replace(prefix, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bMm\b/, "MM") : null;

function playerName(p: Player, humans: number | undefined): string {
  const n = p.name?.trim() || p.personaname?.trim();
  if (n) return n;
  // In a bot match (human_players < 10) only the humans carry leaver_status; bot slots omit it.
  if (humans != null && humans < 10 && p.leaver_status === undefined) return "Bot";
  return "Anonymous";
}

const prettyUnit = (u: string) => u.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function run(argv: string[]): Promise<string> {
  const args = parseCli(USAGE, { booleans: ["draft"] }, argv);
  const id = args.positionals[0];
  if (!id) throw new DotaError(`Missing match id.\nUsage: ${USAGE}`);
  if (!/^\d+$/.test(id) || Number(id) <= 0) throw new DotaError(`Match id must be a positive number (got "${id}").`);
  if (!Number.isSafeInteger(Number(id)) || id.length > 12) throw new DotaError(`"${id}" is not a valid Dota 2 match id (too large).`);
  if (args.positionals.length > 1) throw new DotaError(`Expected one match id.\nUsage: ${USAGE}`);

  const [{ match: m, cache }, modes, lobbies, patches, items] = await Promise.all([
    fetchMatch(id),
    opendota<Record<string, ConstEntry>>("/constants/game_mode", { ttl: TTL.constants }),
    opendota<Record<string, ConstEntry>>("/constants/lobby_type", { ttl: TTL.constants }),
    opendota<OdPatch[]>("/constants/patch", { ttl: TTL.constants }),
    itemMap(),
  ]);

  const parsed = m.version != null;
  const item = (iid: number | undefined) => (iid ? items.get(iid)?.name ?? `Item #${iid}` : null);
  const radiantName = m.radiant_team?.name ?? m.radiant_name ?? null;
  const direName = m.dire_team?.name ?? m.dire_name ?? null;

  const players: PlayerRow[] = [];
  for (const p of m.players) {
    players.push({
      team: p.isRadiant ? "Radiant" : "Dire",
      hero_id: p.hero_id,
      hero: await heroName(p.hero_id),
      player: playerName(p, m.human_players),
      account_id: p.account_id ?? null,
      position_est: p.position_est ?? null,
      lane_role: p.lane_role != null ? LANE_ROLE[p.lane_role] ?? String(p.lane_role) : null,
      is_roaming: p.is_roaming ?? null,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      last_hits: p.last_hits,
      denies: p.denies,
      gpm: p.gold_per_min,
      xpm: p.xp_per_min,
      net_worth: p.net_worth,
      hero_damage: p.hero_damage,
      tower_damage: p.tower_damage,
      items: [p.item_0, p.item_1, p.item_2, p.item_3, p.item_4, p.item_5].map(item).filter((x): x is string => !!x),
      backpack: [p.backpack_0, p.backpack_1, p.backpack_2].map(item).filter((x): x is string => !!x),
      units: (p.additional_units ?? []).map((u) => ({
        unit: prettyUnit(u.unitname),
        items: [u.item_0, u.item_1, u.item_2, u.item_3, u.item_4, u.item_5].map(item).filter((x): x is string => !!x),
      })),
      neutral: item(p.item_neutral),
      enchantment: item(p.item_neutral2),
      // The flag is 0 for a hero holding the Scepter item, so it marks the consumed buff only.
      aghanims_scepter_consumed: p.aghanims_scepter === 1,
      aghanims_shard: p.aghanims_shard === 1,
    });
  }

  let advantage: Result["advantage"] = null;
  // One value per minute (index = minute), per odota/core's API spec.
  const gold = m.radiant_gold_adv;
  if (gold?.length) {
    const xp = m.radiant_xp_adv ?? [];
    const marks = [10, 20, 30].filter((t) => t < gold.length - 1);
    advantage = [
      ...marks.map((t) => ({ minute: t, last: false, gold: gold[t]!, xp: xp[t] ?? null })),
      { minute: gold.length - 1, last: true, gold: gold.at(-1)!, xp: xp.at(-1) ?? null },
    ];
  }

  const missing: string[] = [];
  if (!parsed) {
    if (!m.radiant_gold_adv) missing.push("gold/XP advantage");
    if (m.players.every((p) => p.lane_role == null)) missing.push("lane roles and positions");
    if (!m.objectives) missing.push("objectives");
    if (!m.teamfights) missing.push("teamfights");
    missing.push("wards, purchase timings and other per-minute data");
  }

  const result: Result = {
    source: "OpenDota /matches",
    match_id: m.match_id,
    url: `https://www.opendota.com/matches/${m.match_id}`,
    parsed,
    cache,
    start_time: new Date(m.start_time * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    duration: duration(m.duration),
    winner: m.radiant_win ? "Radiant" : "Dire",
    score: { radiant: m.radiant_score, dire: m.dire_score },
    game_mode: prettyConst(modes[String(m.game_mode)]?.name, "game_mode_") ?? `Mode #${m.game_mode}`,
    lobby_type: prettyConst(lobbies[String(m.lobby_type)]?.name, "lobby_type_") ?? `Lobby #${m.lobby_type}`,
    patch: m.patch != null ? patches.find((x) => x.id === m.patch)?.name ?? null : null,
    league: m.league?.name ?? null,
    teams: { radiant: radiantName, dire: direName },
    first_blood: m.first_blood_time != null ? duration(m.first_blood_time) : null,
    advantage,
    missing_unparsed: missing,
    players,
  };

  if (args.flags.draft) result.draft = await buildDraft(m, players, radiantName, direName);

  return output(args, result, () => render(result));
}

async function buildDraft(
  m: Match,
  players: PlayerRow[],
  radiantName: string | null,
  direName: string | null,
): Promise<NonNullable<Result["draft"]>> {
  const heroes = {
    radiant: players.filter((p) => p.team === "Radiant").map((p) => p.hero),
    dire: players.filter((p) => p.team === "Dire").map((p) => p.hero),
  };
  if (!m.picks_bans?.length) {
    return { available: false, entries: [], note: "Draft order is unavailable for this match (OpenDota has no picks_bans).", unrecorded: [], heroes };
  }
  const entries: DraftEntry[] = [];
  for (const pb of [...m.picks_bans].sort((a, b) => a.order - b.order)) {
    entries.push({
      order: pb.order,
      action: pb.is_pick ? "pick" : "ban",
      team: pb.team === 0 ? "Radiant" : "Dire",
      team_name: pb.team === 0 ? radiantName : direName,
      hero_id: pb.hero_id,
      hero: await heroName(pb.hero_id),
    });
  }
  const notes: string[] = [];
  const bans = entries.filter((e) => e.action === "ban");
  const picks = entries.filter((e) => e.action === "pick");
  // Seen in ranked All Draft: every ban is stored with team 0 and ordered after all picks.
  if (bans.length > 1 && new Set(bans.map((b) => b.team)).size === 1 && new Set(picks.map((p) => p.team)).size === 2) {
    notes.push(`All bans are recorded for ${bans[0]!.team} and ordered after the picks, so ban team and timing are not meaningful here.`);
  }
  const picked = new Set(picks.map((p) => p.hero_id));
  const unrecorded = players.filter((p) => !picked.has(p.hero_id)).map((p) => ({ team: p.team, hero: p.hero }));
  return { available: true, entries, note: notes.join(" ") || null, unrecorded };
}

const signed = (n: number) => (n > 0 ? `+${num(n)}` : num(n));

function render(r: Result): string {
  const out: string[] = [];
  const teamLabel = (side: "Radiant" | "Dire") => {
    const n = side === "Radiant" ? r.teams.radiant : r.teams.dire;
    return n ? `${side} (${n})` : side;
  };
  out.push(`## Match ${r.match_id}: ${teamLabel(r.winner)} won in ${r.duration} (kills: Radiant ${r.score.radiant}, Dire ${r.score.dire})`);
  const meta = [
    `${r.game_mode}, ${r.lobby_type}`,
    r.patch && `patch ${r.patch}`,
    r.league && `league: ${r.league}`,
    `started ${r.start_time.replace("T", " ").replace("Z", " UTC")}`,
    r.first_blood && `first blood ${r.first_blood}`,
  ].filter(Boolean);
  out.push(meta.join(" · "));
  if (r.teams.radiant || r.teams.dire) out.push(`Radiant: ${r.teams.radiant ?? "?"} vs Dire: ${r.teams.dire ?? "?"}`);
  out.push(
    r.parsed
      ? "Replay parsed."
      : `Replay not parsed; missing ${r.missing_unparsed.join(", ")}. A parse can be requested at ${r.url}.`,
  );

  if (r.advantage) {
    out.push("", "**Radiant advantage** (negative = Dire ahead)");
    out.push(table(["Time", "Gold", "XP"], r.advantage.map((a) => [`${a.minute}:00${a.last ? " (last)" : ""}`, signed(a.gold), a.xp == null ? "-" : signed(a.xp)]), ["l", "r", "r"]));
  }

  const hasRoles = r.players.some((p) => p.position_est != null || p.lane_role != null);
  for (const side of ["Radiant", "Dire"] as const) {
    const ps = r.players.filter((p) => p.team === side);
    out.push("", `**${teamLabel(side)}**${side === r.winner ? " (winner)" : ""}`);
    const headers = ["Hero", "Player", ...(hasRoles ? ["Role"] : []), "K/D/A", "LH/DN", "GPM/XPM", "NW", "HD", "TD", "Items"];
    const rows = ps.map((p) => {
      const role = [p.position_est != null ? `pos ${p.position_est}` : null, p.lane_role, p.is_roaming ? "roam" : null]
        .filter(Boolean)
        .join(" ");
      const extras = [
        p.neutral && `N: ${p.neutral}${p.enchantment ? ` (${p.enchantment})` : ""}`,
        !p.neutral && p.enchantment && `N: (${p.enchantment})`,
        p.aghanims_scepter_consumed && "Scepter buff",
        p.aghanims_shard && "Shard",
      ].filter(Boolean);
      return [
        p.hero,
        p.player,
        ...(hasRoles ? [role || "-"] : []),
        `${p.kills}/${p.deaths}/${p.assists}`,
        `${p.last_hits}/${p.denies}`,
        `${p.gpm}/${p.xpm}`,
        num(p.net_worth),
        num(p.hero_damage),
        num(p.tower_damage),
        [p.items.join(", ") || "-", ...p.units.map((u) => `${u.unit}: ${u.items.join(", ") || "-"}`), ...extras].join("; "),
      ];
    });
    const align = headers.map((h) => (["NW", "HD", "TD", "K/D/A", "LH/DN", "GPM/XPM"].includes(h) ? "r" : "l") as "l" | "r");
    out.push(table(headers, rows, align));
  }
  if (r.players.some((p) => p.position_est != null)) {
    out.push("", "_Role: pos = OpenDota's position estimate from early farm and lane; lane from parsed positions._");
  }

  if (r.draft) {
    out.push("", "### Draft");
    if (!r.draft.available) {
      out.push(r.draft.note!);
      out.push(`Radiant: ${r.draft.heroes!.radiant.join(", ")}`, `Dire: ${r.draft.heroes!.dire.join(", ")}`);
    } else {
      out.push(
        table(
          ["#", "Action", "Team", "Hero"],
          r.draft.entries.map((e) => [e.order + 1, e.action === "pick" ? "Pick" : "Ban", e.team_name ? `${e.team} (${e.team_name})` : e.team, e.hero]),
          ["r", "l", "l", "l"],
        ),
      );
      if (r.draft.unrecorded.length) out.push(`Not in recorded picks: ${r.draft.unrecorded.map((u) => `${u.hero} (${u.team})`).join(", ")}`);
      if (r.draft.note) out.push(`_${r.draft.note}_`);
    }
  }

  out.push("", sourceLine(`OpenDota /matches/${r.match_id}`, r.cache));
  return out.join("\n");
}

if (import.meta.main) await main(() => run(Bun.argv.slice(2)));
