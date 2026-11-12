import { duration, output, parseCli, sourceLine, table } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { resolveHero } from "../lib/heroes.ts";
import { parseAccountId } from "../lib/profile.ts";
import {
  type MapData,
  type MapWard,
  buildMapData,
  saveMarkers,
  validateMarkers,
  zone,
} from "../lib/replaymap.ts";

const USAGE = `bun run tools/ReplayMap.ts <match_id> [--account=X] [--hero=X] [--save-markers='<json>'] [--json]

Positional review of a parsed match: where the focus player died, wards on both sides (how long they
lasted, who cleared them), where they stood in lane, and where fights happened. The dashboard draws the
same data on a map.

The focus player is the first one on a saved account (or --account), else --hero.

--save-markers='[{"kind":"ward","x":120,"y":140,"from":10,"to":20,"label":"..."}]' saves coach
markers for the dashboard map (reviews/<match_id>.map.json; replacing earlier ones). kind is
ward, sentry, position or avoid; x/y are map cells as printed here; from/to are optional minutes.
--save-markers='[]' clears them.`;

/** About 1,300 game units: roughly observer range. Used only to say "near". */
const NEAR = 10;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const cell = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;
const aliveAt = (w: MapWard, t: number, end: number) => w.placed <= t && (w.removed ?? end) > t;

function centroid(pts: [number, number, number][]): { x: number; y: number } | null {
  const n = pts.reduce((s, p) => s + p[2], 0);
  if (!n) return null;
  return { x: pts.reduce((s, p) => s + p[0] * p[2], 0) / n, y: pts.reduce((s, p) => s + p[1] * p[2], 0) / n };
}

function render(d: MapData): string {
  const out: string[] = [];
  const f = d.focus != null ? d.players[d.focus]! : null;
  out.push(`## Map review: match ${d.matchId}${f ? `, focus ${f.hero} (${f.team === "radiant" ? "Radiant" : "Dire"})` : ""}`);
  out.push(
    "Spots are OpenDota map cells (x,y about 64-192; Radiant base bottom-left, Dire base top-right; 1 cell is about 128 game units). Zone names are approximate.",
  );
  if (!d.parsed) {
    out.push("", "Replay not parsed: no ward, death or lane positions. Request a parse (LastMatch.ts --parse for your own newest match) and rerun.");
    return out.join("\n");
  }
  if (!f) out.push("", "No focus player (no saved account in this match). Pass --account or --hero for the per-player sections.");

  const name = (slot: number) => d.players[slot]!.hero;
  const end = d.duration;

  if (f) {
    const mine = d.deaths.filter((x) => x.slot === f.slot);
    out.push("", "### Your deaths with a known spot");
    out.push("Only deaths inside OpenDota teamfights have a position; others are missing here.");
    if (!mine.length) out.push("None recorded.");
    else
      out.push(
        table(
          ["Time", "Spot", "Zone", "Enemy obs near (alive)", "Your team's obs near"],
          mine.map((x) => {
            const near = (team: string) =>
              d.wards.filter((w) => w.type === "obs" && w.team === team && aliveAt(w, x.time, end) && dist(w, x) <= NEAR);
            const enemy = near(f.team === "radiant" ? "dire" : "radiant");
            const own = near(f.team);
            return [
              duration(x.time),
              cell(x),
              zone(x.x, x.y),
              enemy.length ? enemy.map((w) => `${cell(w)} (${name(w.slot)}, placed ${duration(w.placed)})`).join("; ") : "none",
              own.length ? String(own.length) : "none",
            ];
          }),
        ),
      );

    const myWards = d.wards.filter((w) => w.slot === f.slot);
    if (myWards.length) {
      out.push("", "### Your wards");
      out.push(
        table(
          ["Placed", "Type", "Spot", "Zone", "Lasted", "Cleared by"],
          myWards.map((w) => [
            duration(w.placed),
            w.type === "obs" ? "Observer" : "Sentry",
            cell(w),
            zone(w.x, w.y),
            w.removed == null ? "to game end" : duration(w.removed - w.placed),
            w.early ? w.by ?? "removed early" : "",
          ]),
        ),
      );
    }

    const myLane = centroid(d.lanePos[f.slot] ?? []);
    if (myLane) {
      out.push("", "### Laning position (OpenDota lane_pos, early game)");
      const top = [...(d.lanePos[f.slot] ?? [])].sort((a, b) => b[2] - a[2]).slice(0, 3);
      const opp = d.players
        .filter((p) => p.team !== f.team)
        .map((p) => ({ p, c: centroid(d.lanePos[p.slot] ?? []) }))
        .filter((o) => o.c && dist(o.c, myLane) < 25)
        .sort((a, b) => dist(a.c!, myLane) - dist(b.c!, myLane));
      out.push(`You: centre ${cell(myLane)} (${zone(myLane.x, myLane.y)}); most time at ${top.map((t) => `${t[0]},${t[1]}`).join(" / ")}.`);
      for (const o of opp.slice(0, 2)) out.push(`Lane opponent ${o.p.hero}: centre ${cell(o.c!)} (${zone(o.c!.x, o.c!.y)}), ${dist(o.c!, myLane).toFixed(0)} cells from yours.`);
    }
  }

  const team = f?.team ?? "radiant";
  const enemy = team === "radiant" ? "dire" : "radiant";
  const label = (t: string) => (f ? (t === team ? "yours" : "enemy") : t === "radiant" ? "Radiant" : "Dire");

  const obs = d.wards.filter((w) => w.type === "obs");
  const proven = obs.filter((w) => !w.early).slice();
  out.push("", "### Observer spots that lasted (not cleared early)");
  out.push(proven.length ? table(["Placed", "Side", "Spot", "Zone", "By"], proven.slice(0, 14).map((w) => [duration(w.placed), label(w.team), cell(w), zone(w.x, w.y), name(w.slot)])) : "None.");
  if (proven.length > 14) out.push(`(${proven.length - 14} more in --json)`);

  const cleared = obs.filter((w) => w.early);
  out.push("", "### Observers cleared early");
  out.push(
    cleared.length
      ? table(
          ["Placed", "Side", "Spot", "Zone", "Lasted", "Cleared by"],
          cleared.map((w) => [duration(w.placed), label(w.team), cell(w), zone(w.x, w.y), duration((w.removed ?? end) - w.placed), w.by ?? "?"]),
        )
      : "None.",
  );

  if (f) {
    const myHalf = (w: MapWard) => (team === "radiant" ? w.x + w.y < 256 : w.x + w.y > 256);
    const unchecked = obs.filter((w) => w.team === enemy && !w.early && myHalf(w));
    out.push("", "### Enemy observers in your half that your team never cleared");
    out.push(unchecked.length ? table(["Placed", "Spot", "Zone", "By"], unchecked.map((w) => [duration(w.placed), cell(w), zone(w.x, w.y), name(w.slot)])) : "None.");
  }

  const fights = d.fights.filter((x) => x.x != null);
  if (fights.length) {
    out.push("", "### Teamfights");
    out.push(
      table(
        ["Time", "Spot", "Zone", "Radiant deaths", "Dire deaths", ...(f ? ["You died"] : [])],
        fights.map((x) => [
          `${duration(x.start)}-${duration(x.end)}`,
          cell({ x: x.x!, y: x.y! }),
          zone(x.x!, x.y!),
          x.radiantDeaths,
          x.direDeaths,
          ...(f ? [d.deaths.some((k) => k.slot === f.slot && k.time >= x.start - 2 && k.time <= x.end + 2) ? "yes" : ""] : []),
        ]),
      ),
    );
  }

  if (d.markers.length) {
    out.push("", "### Saved coach markers");
    out.push(table(["Kind", "Spot", "Minutes", "Label"], d.markers.map((m) => [m.kind, cell(m), m.from != null || m.to != null ? `${m.from ?? 0}-${m.to ?? ""}` : "", m.label])));
  }
  out.push("", sourceLine(`OpenDota /matches/${d.matchId}`, d.cache));
  return out.join("\n");
}

/** `accounts`: the user's saved account ids (main first); the focus player is the first one in the match. */
export async function run(argv: string[], ctx: { accounts: () => Promise<number[]> }): Promise<string> {
  const args = parseCli(USAGE, { strings: ["account", "hero", "save-markers"] }, argv);
  const id = args.positionals[0];
  if (!id || args.positionals.length > 1) throw new DotaError(`Expected one match id.\nUsage: ${USAGE}`);
  if (!/^\d{1,12}$/.test(id) || Number(id) <= 0) throw new DotaError(`Match id must be a positive number (got "${id}").`);

  const save = args.flags["save-markers"];
  if (typeof save === "string") {
    let raw: unknown;
    try {
      raw = JSON.parse(save);
    } catch {
      throw new DotaError("--save-markers is not valid JSON. Wrap it in single quotes in the shell.");
    }
    const markers = validateMarkers(raw);
    await saveMarkers(id, markers);
    return `Saved ${markers.length} marker(s) for match ${id}. The dashboard map shows them.\n`;
  }

  const accounts =
    typeof args.flags.account === "string"
      ? [parseAccountId(args.flags.account)]
      : await ctx.accounts();
  const heroId = typeof args.flags.hero === "string" ? (await resolveHero(args.flags.hero)).id : undefined;
  const data = await buildMapData(id, { accounts: typeof args.flags.account === "string" || !heroId ? accounts : [], heroId });
  return output(args, data, () => render(data));
}

if (import.meta.main) {
  const { loadProfile, profileAccounts } = await import("../lib/profile.ts");
  await main(() => run(Bun.argv.slice(2), { accounts: async () => profileAccounts(loadProfile()).map((a) => a.account_id) }));
}
