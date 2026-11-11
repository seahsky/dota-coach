# MetaAnalysis

What is strong right now in a bracket and role: which heroes win, which are popular, which are sleepers or traps, and how pro play differs from pubs.

## When to use
- "What's meta?", "best carries in Legend?", "what should I spam to climb?", "what are pros picking?", "is X overrated?"
- Not for one hero in depth (use HeroBreakdown) or for what a patch changed (use AnalyzePatch).

Your built-in Dota knowledge is out of date: hero names, patch numbers, winrates and the meta have all moved (facets were removed in 7.41, lettered patches exist). Do not name a "strong" hero, a winrate or a patch until a tool has printed it in this session.

## Inputs
Ask only for what is missing and changes the answer:
- **Bracket**: herald, guardian, crusader, archon, legend, ancient, divine, immortal (or 1-8), `pro`, `turbo`. Without one, use `all` and say so.
- **Role**: pos1-pos5, or carry/mid/offlane/soft/hard. "Support" is ambiguous; ask soft (pos 4) or hard (pos 5). Skip if they want the whole meta.
- **Goal** (optional): climbing in pubs vs following pro trends. Do not ask if the question already implies it.

## Steps
Run from the skill directory (`cd ~/.claude/skills/DotaCoach`). The cache is on; do not set DOTACOACH_NO_CACHE. On a rate-limit error, wait 60s and retry once.

1. Patch context: `bun run tools/GetPatch.ts`. Note the version, release date (UTC) and source line. If the patch is less than 7 days old, the stats window below mixes pre- and post-patch games.
2. Bracket table: `bun run tools/GetHeroStats.ts --bracket=<bracket> --top=30` (sorted by winrate), then `--sort=pickrate --top=30` for popularity.
3. Quadrants: dump the full bracket and classify it (step "Quadrants" below):
   `bun run tools/GetHeroStats.ts --bracket=<bracket> --top=200 --min-picks=0 --json | bun -e '<snippet>'`
4. Role, if asked: `bun run tools/GetHeroStats.ts --role=pos<N> --top=20`. Read the source line: without STRATZ_API_KEY this is pro league matches over 30 days with estimated positions, and `--bracket` is not applied. Use it to see which heroes are played in that position, not as the user's bracket winrate.
5. Pro vs pub: `bun run tools/GetHeroStats.ts --bracket=pro --sort=pickrate --top=25` and compare against step 2.
6. Optional drill-down on 2-4 heroes you plan to recommend: `bun run tools/GetPatch.ts --hero="<hero>"` (recent changes) and `bun run tools/GetItemBuilds.ts "<hero>"` (what the build looks like now). Use `bun run tools/GetHero.ts "<hero>"` only if you need to explain how the hero works.

### Quadrants snippet
Paste as the `bun -e` argument in step 3. It splits on the bracket's median pick rate and on win rate vs 50%, using the larger of 1.5 points or the 95% binomial margin:
```js
const r=JSON.parse(await Bun.stdin.text()),h=r.heroes.filter(x=>x.picks>0),pr=h.map(x=>x.pickrate).sort((a,b)=>a-b),med=pr[pr.length>>1];
const q=x=>{const d=x.winrate-.5,m=Math.max(.015,1.96*Math.sqrt(.25/x.picks)),hi=x.pickrate>=med;return d>m?(hi?"popular-winning":"sleeper"):d<-m?(hi?"trap":"weak"):"near-even"};
const g={};for(const x of h)(g[q(x)]??=[]).push(`${x.name} ${(x.winrate*100).toFixed(1)}%/${(x.pickrate*100).toFixed(1)}% (${x.picks})`);
console.log(r.source,"|",r.sample.description,"| median pick rate",(med*100).toFixed(1)+"%");for(const k in g)console.log(`${k} [${g[k].length}]:`,g[k].slice(0,8).join(", "))
```
`winrate` and `pickrate` in `--json` are fractions (0.551), not percentages. Lists are in the tool's sort order (winrate, highest first).

## Reading the outputs
**GetHeroStats (OpenDota /heroStats)**
- Window: last 7 days of daily buckets, current day partial. It is a snapshot; it cannot show change since the patch except via Trend.
- `all` = OpenDota's public counter: non-Turbo games outside premium/pro leagues, including unranked and unknown-rank games, so it is bigger than the rank brackets combined. Rank brackets are bucketed by the match's average medal.
- `divine` and `immortal` both read the "Divine + Immortal" bucket; OpenDota never fills its Immortal bracket. Say "Divine + Immortal", not "Immortal".
- Pick rate = picks / matches, the share of matches the hero appeared in (either team). Win rates across a bracket average 50%.
- Sample size: read the Sample line. Brackets range from tens of thousands of matches (Herald) to millions (`all`, Turbo). The 95% margin on a hero's win rate is about 1.96 x sqrt(0.25 / picks): about 1 point at 10k picks, about 2 points at 2.5k. The printed min-picks line says how many heroes were hidden. Turbo is its own population; do not use it for ranked advice.
- Pro: about 170 matches per week. A hero with 20 picks has a margin of about 22 points. Do not rank pro heroes by winrate; use pick rate, bans and Contest = (picks + bans) / matches.
- Trend (only in `all`): win rate change in points, days 4-6 vs days 1-3. Values under about 0.5 points are noise.
- `--role` source line says either STRATZ (ranked pubs, user's bracket, 7 days) or OpenDota explorer (pro, estimated positions, 30 days). If it says "STRATZ failed, fell back", repeat the reason.

**GetPatch**: buff/nerf ranking is a text heuristic; quote driver lines, not scores.

What the data cannot tell you: why a hero wins (skill of the people picking it, counter-picks, game length), how it does by position in pubs without STRATZ, or how it did before the current 7-day window.

## Turning data into advice
- **Popular and winning** (high pick, win rate clearly above 50%): the safe meta. In pubs these are good picks to climb with, but expect them to be banned or countered more.
- **Sleeper** (low pick, high win): check picks first. Low pick rate concentrates specialists, so a niche hero's win rate overstates what a first-time player gets. Recommend sleepers to players willing to learn them, or who already play them.
- **Trap** (high pick, win rate clearly below 50%): popular but losing in this bracket. Common causes: an easy-to-pick hero that needs team follow-up, or a hero the meta counters. Advise against it unless the user already has many games on it.
- **Weak / near-even**: most heroes. Near 50% is playable; do not tell someone to drop a comfort hero over 1-2 points.
- Compare brackets: a hero winning in Herald/Guardian but not in Divine is usually forgiving or punishes low coordination; one that wins only at high ranks rewards execution. Run the user's bracket and one neighbour or `all` before saying "this bracket specifically".
- Pro vs pub: high pro contest with a flat pub win rate usually means the hero relies on draft and coordination (save for 5-stacks). High pub win rate with low pro presence usually means it beats uncoordinated play. Never tell a pub player to pick a hero "because pros do" without its pub numbers.
- Role: pick 2-3 heroes from that role's list that are also popular-winning or sleeper in the user's bracket table. Say when the role list came from pro data.
- Patch: if GetPatch lists a hero among buffs or nerfs and it shows up in a quadrant, mention the change line; do not claim the patch caused the number.

## Answer format
1. One line of context: patch, release date, bracket, window, sample ("7.41f, OpenDota Legend, last 7 days, 896,063 matches").
2. Top picks: 3-6 heroes with win rate, pick rate and quadrant. For a role, 3-5 heroes from that role.
3. Sleepers and traps: 2-4 each, one line of reasoning per hero.
4. Pro vs pub: 2-3 contrasts, with contest rate and pro sample size.
5. Concrete recommendation tied to the user's goal and pool.
6. Caveats in one or two lines: sources used, STRATZ status, what the data cannot show.

Quote numbers exactly as the tools print them, with the bracket they came from.

## Pitfalls
- Naming meta heroes from memory, or using hero names the tools do not print.
- Mixing brackets or sources in one list without labels; calling the Divine + Immortal bucket "Immortal".
- Ranking pro heroes by win rate with 10-30 picks.
- Treating `--role` without STRATZ as the user's bracket; it is pro data.
- Calling a 0.5-point difference meaningful, or reading a sleeper's win rate as what a new player will get.
- Saying "after the patch X went up" with one snapshot. Say "currently".
