import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DotaError } from "./errors.ts";
import { heroMap } from "./heroes.ts";
import { type Match, fetchMatch } from "./match.ts";
import { REVIEWS_DIR } from "./watcher.ts";

/**
 * Positional data from a parsed OpenDota match, for the map view in the dashboard
 * and the text summary in tools/ReplayMap.ts.
 *
 * Coordinates are OpenDota's map cells: x and y run from about 64 to 192, Radiant's
 * base is bottom-left (low x, low y) and Dire's is top-right. One cell is about 128
 * game units.
 */

export type Team = "radiant" | "dire";

export interface MapPlayer {
  slot: number; // index into match.players
  hero: string;
  heroId: number;
  team: Team;
  name: string;
  pos: number | null;
  lane: string | null;
  accountId: number | null;
}

export interface MapWard {
  slot: number;
  team: Team;
  type: "obs" | "sen";
  x: number;
  y: number;
  placed: number;
  /** Second the ward disappeared; null if it was still up when the game ended. */
  removed: number | null;
  /** Removed well before its full lifetime. */
  early: boolean;
  /** Enemy hero credited with removing it, when the log names one. */
  by: string | null;
}

export interface MapDeath {
  slot: number;
  x: number;
  y: number;
  time: number;
}

export interface MapFight {
  start: number;
  end: number;
  x: number | null;
  y: number | null;
  radiantDeaths: number;
  direDeaths: number;
}

export type MarkerKind = "ward" | "sentry" | "position" | "avoid";

export interface CoachMarker {
  kind: MarkerKind;
  x: number;
  y: number;
  /** Minutes the advice applies to, if it is time-bound. */
  from?: number;
  to?: number;
  label: string;
}

export interface MapData {
  matchId: number;
  parsed: boolean;
  duration: number;
  radiantWin: boolean;
  focus: number | null;
  players: MapPlayer[];
  wards: MapWard[];
  deaths: MapDeath[];
  fights: MapFight[];
  /** Per player slot: [x, y, samples] cells from OpenDota's lane_pos (early game). */
  lanePos: [number, number, number][][];
  markers: CoachMarker[];
  cache: string;
}

interface WardLog {
  time: number;
  x: number;
  y: number;
  ehandle?: number;
  key?: string;
  attackername?: string;
}
interface ParsedPlayer {
  obs_log?: WardLog[];
  sen_log?: WardLog[];
  obs_left_log?: WardLog[];
  sen_left_log?: WardLog[];
  lane_pos?: Record<string, Record<string, number>>;
  deaths_log?: { time: number }[];
  personaname?: string | null;
  name?: string | null;
}
interface ParsedFight {
  start: number;
  end: number;
  players?: { deaths_pos?: Record<string, Record<string, number>> }[];
}

const LANE: Record<number, string> = { 1: "safe", 2: "mid", 3: "off", 4: "jungle" };

export const MARKERS_FILE = (matchId: number | string) => join(REVIEWS_DIR, `${matchId}.map.json`);

/**
 * Coarse map zone for a cell: base, mid lane, river or half, plus which side of the mid lane.
 * Only the river (x + y = 256) and mid lane (x = y) diagonals are used; side-lane edges are not modelled.
 */
export function zone(x: number, y: number): string {
  const d = x + y - 256; // > 0: Dire half, < 0: Radiant half
  if (x < 92 && y < 92) return "Radiant base";
  if (x > 164 && y > 164) return "Dire base";
  const flank = y > x ? "top" : "bot";
  if (Math.abs(x - y) < 6) return Math.abs(d) < 8 ? "mid lane, river" : `mid lane, ${d > 0 ? "Dire" : "Radiant"} half`;
  if (Math.abs(d) < 8) return `river, ${flank} side`;
  return `${d > 0 ? "Dire" : "Radiant"} half, ${flank} side`;
}

function cells(h: Record<string, Record<string, number>> | undefined): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const [x, ys] of Object.entries(h ?? {})) for (const [y, n] of Object.entries(ys)) out.push([Number(x), Number(y), n]);
  return out;
}

/** Focus player: the first one on a given account, else the one playing `heroId`. */
export async function buildMapData(matchId: string, focus: { accounts?: number[]; heroId?: number } = {}): Promise<MapData> {
  const { match: m, cache } = await fetchMatch(matchId);
  const heroes = await heroMap();
  const byNpc = new Map([...heroes.values()].map((h) => [h.npc, h.name]));
  const team = (i: number): Team => (m.players[i]!.isRadiant ? "radiant" : "dire");

  const players: MapPlayer[] = m.players.map((p, i) => {
    const pp = p as unknown as ParsedPlayer;
    return {
      slot: i,
      hero: heroes.get(p.hero_id)?.name ?? `Hero #${p.hero_id}`,
      heroId: p.hero_id,
      team: team(i),
      name: pp.name?.trim() || pp.personaname?.trim() || "Anonymous",
      pos: p.position_est ?? null,
      lane: p.lane_role != null ? LANE[p.lane_role] ?? null : null,
      accountId: p.account_id ?? null,
    };
  });
  const heroTeam = new Map(players.map((p) => [heroes.get(p.heroId)?.npc ?? "", p.team]));

  const wards: MapWard[] = [];
  for (const [i, p] of m.players.entries()) {
    const pp = p as unknown as ParsedPlayer;
    for (const type of ["obs", "sen"] as const) {
      const placed = pp[`${type}_log`] ?? [];
      const left = pp[`${type}_left_log`] ?? [];
      const used = new Set<number>();
      for (const w of placed) {
        // Match the removal by entity handle; older parses only have the cell key.
        const j = left.findIndex((l, k) => !used.has(k) && l.time >= w.time && (w.ehandle != null ? l.ehandle === w.ehandle : l.key === w.key));
        if (j >= 0) used.add(j);
        const l = j >= 0 ? left[j]! : null;
        const attacker = l?.attackername ?? "";
        const by = heroTeam.has(attacker) && heroTeam.get(attacker) !== team(i) ? byNpc.get(attacker) ?? null : null;
        wards.push({ slot: i, team: team(i), type, x: w.x, y: w.y, placed: w.time, removed: l ? l.time : null, early: false, by });
      }
    }
  }
  // Full lifetime per ward type, read from this match (the longest-lived ward), so it follows patch changes.
  for (const type of ["obs", "sen"] as const) {
    const lives = wards.filter((w) => w.type === type && w.removed != null).map((w) => w.removed! - w.placed);
    const full = Math.max(0, ...lives);
    for (const w of wards) if (w.type === type && w.removed != null) w.early = full > 0 && w.removed - w.placed < full - 15;
  }

  const deaths: MapDeath[] = [];
  const fights: MapFight[] = [];
  for (const f of (m.teamfights ?? []) as ParsedFight[]) {
    const fd: MapDeath[] = [];
    for (const [i, fp] of (f.players ?? []).entries()) {
      if (i >= m.players.length) break;
      const spots = cells(fp.deaths_pos).flatMap(([x, y, n]) => Array.from({ length: n }, () => [x, y] as const));
      if (!spots.length) continue;
      const times = ((m.players[i] as unknown as ParsedPlayer).deaths_log ?? [])
        .map((d) => d.time)
        .filter((t) => t >= f.start - 2 && t <= f.end + 2);
      spots.forEach(([x, y], k) => fd.push({ slot: i, x, y, time: times[k] ?? Math.round((f.start + f.end) / 2) }));
    }
    deaths.push(...fd);
    const cx = fd.length ? fd.reduce((s, d) => s + d.x, 0) / fd.length : null;
    const cy = fd.length ? fd.reduce((s, d) => s + d.y, 0) / fd.length : null;
    fights.push({
      start: f.start,
      end: f.end,
      x: cx,
      y: cy,
      radiantDeaths: fd.filter((d) => team(d.slot) === "radiant").length,
      direDeaths: fd.filter((d) => team(d.slot) === "dire").length,
    });
  }

  const set = new Set(focus.accounts ?? []);
  let fi = m.players.findIndex((p) => p.account_id != null && set.has(p.account_id));
  if (fi < 0 && focus.heroId) fi = m.players.findIndex((p) => p.hero_id === focus.heroId);

  return {
    matchId: m.match_id,
    parsed: m.version != null,
    duration: m.duration,
    radiantWin: m.radiant_win,
    focus: fi >= 0 ? fi : null,
    players,
    wards: wards.sort((a, b) => a.placed - b.placed),
    deaths: deaths.sort((a, b) => a.time - b.time),
    fights,
    lanePos: m.players.map((p) => cells((p as unknown as ParsedPlayer).lane_pos)),
    markers: loadMarkers(m.match_id),
    cache,
  };
}

// ---------- coach markers (reviews/<id>.map.json) ----------

const KINDS: MarkerKind[] = ["ward", "sentry", "position", "avoid"];

export function validateMarkers(raw: unknown): CoachMarker[] {
  const list = Array.isArray(raw) ? raw : (raw as { markers?: unknown })?.markers;
  if (!Array.isArray(list)) throw new DotaError("Markers must be a JSON array of {kind, x, y, label, from?, to?}.");
  if (list.length > 12) throw new DotaError("At most 12 markers.");
  return list.map((r, i) => {
    const o = r as Record<string, unknown>;
    const where = `Marker ${i + 1}`;
    if (!KINDS.includes(o.kind as MarkerKind)) throw new DotaError(`${where}: kind must be one of ${KINDS.join(", ")}.`);
    for (const k of ["x", "y"]) {
      const v = o[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 60 || v > 196) throw new DotaError(`${where}: ${k} must be a map cell between 60 and 196.`);
    }
    if (typeof o.label !== "string" || !o.label.trim()) throw new DotaError(`${where}: label is required.`);
    const minute = (k: string) => {
      const v = o[k];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 300) throw new DotaError(`${where}: ${k} must be a minute between 0 and 300.`);
      return v;
    };
    const from = minute("from");
    const to = minute("to");
    if (from !== undefined && to !== undefined && to < from) throw new DotaError(`${where}: to is before from.`);
    return {
      kind: o.kind as MarkerKind,
      x: Math.round((o.x as number) * 10) / 10,
      y: Math.round((o.y as number) * 10) / 10,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      label: o.label.trim().replace(/\s+/g, " ").slice(0, 200),
    };
  });
}

export function loadMarkers(matchId: number | string): CoachMarker[] {
  try {
    return validateMarkers(JSON.parse(readFileSync(MARKERS_FILE(matchId), "utf8")));
  } catch {
    return [];
  }
}

export function saveMarkers(matchId: number | string, markers: CoachMarker[]): string {
  mkdirSync(REVIEWS_DIR, { recursive: true });
  const file = MARKERS_FILE(matchId);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ markers }, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}
