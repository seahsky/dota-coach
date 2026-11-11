# MatchAnalysis

Review one match by id: where it was decided, how the lanes went, whether items came on time, what the draft did, and three concrete takeaways for the player the user cares about.

## When to use
- "Analyze match 9085010599", "why did we lose this game?", "review my Slardar game", a pasted opendota.com/dotabuff/stratz match link (take the number from it).
- Not for general hero advice with no game (HeroBreakdown) or picking counters before a game (Counterpick).

Your built-in Dota knowledge is out of date (facets were removed in 7.41, item and ability values have changed). Do not state current numbers, timings or meta claims unless a tool printed them in this session. When you quote a number, say which tool and sample it came from.

## Inputs
Ask only for what is missing:
- **Match id** (required). A positive integer.
- **Whose game**: the hero (or player name) to focus on. If not given, ask; if the user does not care, focus on the losing side's core with the worst lane, and say so.
- **Their bracket** (optional): helps judge timings, since comparison data is pro play.

## Steps
Run from the skill directory. The cache is on; never set DOTACOACH_NO_CACHE. On a rate-limit message wait 60s and retry once. A parsed match is cached forever, so rerunning GetMatch is free.

1. `bun run tools/GetMatch.ts <id> --draft` for the overview, advantage table, player rows and draft. Add `--json` if you need exact fields (`parsed`, `advantage[]`, `players[].position_est`, `lane_role`, `units[]` for Spirit Bear items).
2. If the header says `Replay parsed.`, pull the timelines GetMatch does not print (objectives, teamfights, 10-minute lane numbers, first purchase times, OpenDota percentiles). This reads the cached match only, no extra request:
```
ID=<id> bun -e '
import { cacheGetStale } from "./lib/cache.ts"; import { OPENDOTA } from "./lib/http.ts";
import { heroName } from "./lib/heroes.ts"; import { itemMap } from "./lib/items.ts";
const m = cacheGetStale(`${OPENDOTA}/matches/${process.env.ID}`)?.data;
if (!m?.version) { console.log("No cached parsed match. Run GetMatch first; unparsed matches have no timelines."); process.exit(1); }
const mm = s => `${Math.floor(s/60)}:${String(Math.abs(s%60)).padStart(2,"0")}`;
const items = new Map([...(await itemMap()).values()].map(i => [i.key, i]));
console.log("## Objectives (team 2 = Radiant, 3 = Dire; badguys = Dire building)");
for (const o of m.objectives ?? []) console.log(mm(o.time), o.type, o.key ?? "", o.team ?? "", o.unit ?? "");
console.log("## Teamfights (start-end, deaths)");
for (const t of m.teamfights ?? []) console.log(`${mm(t.start)}-${mm(t.end)} deaths ${t.deaths}`);
console.log("## Players at 10:00 and item timings (cost >= 1000)");
for (const p of m.players) {
  const at = (a, i) => a?.[Math.min(i, a.length - 1)];
  const big = Object.entries(p.first_purchase_time ?? {}).filter(([k]) => (items.get(k)?.cost ?? 0) >= 1000).sort((a, b) => a[1] - b[1]).map(([k, t]) => `${items.get(k).name} ${mm(t)}`);
  const b = p.benchmarks ?? {}; const pc = k => b[k]?.pct == null ? "?" : Math.round(b[k].pct * 100);
  console.log(`${p.isRadiant ? "R" : "D"} ${await heroName(p.hero_id)} pos ${p.position_est ?? "?"} lane ${p.lane_role ?? "?"} | 10min gold ${at(p.gold_t,10)} lh ${at(p.lh_t,10)} dn ${at(p.dn_t,10)} xp ${at(p.xp_t,10)} | deaths before 10:00 ${(p.deaths_log ?? []).filter(d => d.time < 600).length} | pctile gpm ${pc("gold_per_min")} lh/min ${pc("last_hits_per_min")} deaths ${pc("deaths_per_min")}`);
  console.log("   " + (big.join(", ") || "no purchase log"));
}'
```
3. `bun run tools/GetItemBuilds.ts "<focus hero>"` for what that hero usually buys and in which phase. Run it for the enemy core too if their item caused the loss.
4. `bun run tools/GetMatchups.ts "<focus hero>" --vs="<enemy>"` for the 1-2 lane opponents and the enemy core that dominated. Use `--top=8` (default) only if the draft itself is the question.
5. `bun run tools/GetHero.ts "<hero>"` for the focus hero and any enemy whose ability you will name in advice (debuff-immunity piercing, cooldowns, ranges).
6. Optional: `bun run tools/GetPatch.ts --hero="<focus hero>"` to check for kit changes. GetMatch prints only the major patch (e.g. `7.41`), so compare the match's start date with the patch release date GetPatch prints before saying which letter patch the game was on.

## Unparsed matches
GetMatch prints `Replay not parsed; missing ...` and a link. You still have result, duration, K/D/A, LH/DN, GPM/XPM, net worth, hero and tower damage, final items and the draft. You do not have advantage graphs, lanes, positions, objectives, purchase times. Do not infer timings or lane results. Tell the user they can request a parse on the printed opendota.com page and rerun later (unparsed results are refreshed after 1h). Meanwhile give takeaways only from end-of-game numbers, the final build vs GetItemBuilds, and the draft, and label the review as limited.

## Reading the outputs
- **Advantage table**: Radiant minus Dire, one sample per minute; GetMatch shows 10/20/30 and the last full minute. Gold and XP can diverge; XP lead with a small gold lead often means the lead came from kills and levels, not farm.
- **Objectives** (step 2): `building_kill` keys say whose building (`badguys` = Dire, `goodguys` = Radiant) and tier (`tower1`..`tower4`, `range_rax`/`melee_rax`, `fort`). `CHAT_MESSAGE_ROSHAN_KILL` and `CHAT_MESSAGE_AEGIS` carry the team (2 Radiant, 3 Dire). `CHAT_MESSAGE_COURIER_LOST` `team` is the side that lost the courier. Other types: report as printed, do not guess their meaning.
- **Role column**: `pos N` is OpenDota's estimate from minutes 10-12 farm, lane and early wards. Lane label is relative to the team: one team's `safe` (1) shares a lane with the other team's `off` (3); mids (2) face each other.
- **10-minute numbers**: compare a player with their direct lane opponent of the same role (pos 1 vs enemy pos 3, mid vs mid). Ignore OpenDota's `lane_efficiency_pct`: it divides by a fixed creep-gold constant from patch 6.84 (odota/core compute.ts).
- **Percentiles**: `pctile` is OpenDota `benchmarks.pct`, the share of that hero's recent recorded games at or below this value (for deaths it is inverted, so higher means fewer deaths). It is not bracket-matched. Use it for "farm was low for this hero", not as a grade.
- **Item timings**: first purchase time of each item costing 1000+, including components. A finished item appears at the time its last part was bought.
- **GetItemBuilds**: the hero's 100 most recent parsed league matches. Phases are OpenDota's windows (start, 0-10, 10-25, 25+ min, with cost floors). It gives what is bought in each phase, not average minute timings. Pro builds may not fit a pub game; say so.
- **GetMatchups**: the focus hero's winrate in pro matches over 365 days (if the source line names STRATZ, its bracket data). Delta inside the +/- margin is noise. It cannot show whether the matchup is decided in lane.

## Finding the deciding phase
Pick the first point where the eventual winner's lead became decisive and name what caused it:
- **Lane (0-10)**: gold or XP gap at 10:00 over about 2,000, or tier-1 towers falling before 10:00, or a core with 2+ deaths before 10:00.
- **Mid game (10-25)**: the lead swings or more than doubles between 10 and 20, usually next to a teamfight with 3+ deaths, a Roshan kill or a run of tier-2 towers.
- **Late (25+)**: the advantage flips or the trailing side's barracks fall after a fight. Check buybacks and Aegis timing.
- Thrown games: the leading side loses the lead; find the teamfight or Roshan just before the swing.
These cut-offs are coaching heuristics, not OpenDota definitions. If the data does not show a clear swing, say the game was a slow accumulation.

## Turning data into advice
- Every takeaway must cite a number from this match (a time, a gold gap, a death count) and a comparison (lane opponent, GetItemBuilds phase, OpenDota percentile).
- Lane lost: was it deaths (check `deaths before 10:00`), last hits, or a bad matchup (GetMatchups row clearly beyond the margin, plus the mechanism from GetHero)? Advice differs: positioning vs farm pattern vs lane or pick choice.
- Late core item: if the item the hero buys in the 10-25 phase in GetItemBuilds arrived after 25:00, name the farm gap or the detour items bought first (e.g. extra components, a second support item). Do not quote a pro "standard timing" minute; the tool does not give one.
- Wrong item: if the enemy had debuff immunity, evasion, illusions or heavy healing (from their final items and GetHero), check whether the focus player bought the answer and when.
- Supports: judge by deaths, hero damage, final utility items (Force Staff, Glimmer Cape, wards in backpack) and lane result for their core, not GPM.
- Draft: one point only, if GetMatchups shows a significant bad row or the lineup had no answer to a key enemy mechanic. For All Draft pubs with the ban note, ignore ban order.
- Make each takeaway an action for next game: what to do, when, and what signal to watch.

## Answer format
1. One-line result: winner, duration, score, patch, mode, parsed or not.
2. Deciding phase: the phase and 2-3 data points (advantage, objectives, fight).
3. Lane: focus player vs lane opponent at 10:00 (gold, LH/DN, XP, early deaths).
4. Items: focus player's key timings vs GetItemBuilds phases and what the enemy built that mattered.
5. Draft: one or two lines, or "not a factor".
6. **Three takeaways**, numbered, each with the evidence and the action.
7. Sources: GetMatch (OpenDota match, parsed/unparsed, cache line), GetItemBuilds sample (league matches, date range), GetMatchups population and STRATZ status as printed, any fallback reason.

## Pitfalls
- Presenting pro item or matchup samples as the user's bracket.
- Reading the advantage table from the wrong side: positive is Radiant ahead.
- Inventing lane or timing data for an unparsed match.
- Item nicknames: GetPatch `--item` needs full names.
- Lone Druid's items are on the Spirit Bear (`units[]` / "Spirit Bear:" in the row).
- `Scepter buff` means the consumed Aghanim's Blessing effect; Scepter in the item list is the held item.
- Running GetMatchups for all 10 heroes: it burns rate limit for little value. Pick the 1-3 relevant matchups.
