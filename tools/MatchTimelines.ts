import { matchTimelines } from "../lib/coach/timelines.ts";
import { DotaError, main } from "../lib/errors.ts";

const USAGE = `bun run tools/MatchTimelines.ts <match_id>

Objectives, teamfights, each player's numbers at 10:00 (gold, LH/DN, XP, early deaths),
item purchase times for items costing 1000+ and OpenDota percentiles. Parsed matches only;
uses the same cache as GetMatch.`;

if (import.meta.main) {
  await main(async () => {
    const args = Bun.argv.slice(2);
    if (args.includes("--help")) return `Usage: ${USAGE}\n`;
    const id = args[0];
    if (!id || !/^\d{1,12}$/.test(id) || args.length > 1) throw new DotaError(`Expected one match id.\nUsage: ${USAGE}`);
    return matchTimelines(id);
  });
}
