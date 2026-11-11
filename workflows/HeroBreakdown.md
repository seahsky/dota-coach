# HeroBreakdown

Deep dive on one hero: kit, talents, current numbers, how it is doing in the user's bracket, items by phase, matchups, how to play each phase, and what it wants from teammates.

## When to use
- "Teach me X", "how do I play X", "is X good right now", "what do I build on X", "who counters X".
- A narrower question (just items, just one matchup) can use the single matching step, but still follow the interpretation rules below.
- Not for reviewing a specific game (use GetMatch) or for draft help across many heroes.

## Inputs
- Hero (required). Names, nicknames, prefixes and ids all resolve. If the tool errors with "Unknown hero ... Closest matches", ask which one.
- Rank bracket (ask if missing and the user wants winrates or advice for their games): herald, guardian, crusader, archon, legend, ancient, divine, immortal. Without it, use `all` and say so.
- Position the user plays the hero in (pos1-pos5), only if the hero is played in more than one role. Do not ask otherwise.
- Do not ask for anything else. Opponent heroes are optional; use them with `--vs` if given.

## Steps
Run from the skill directory. The cache is on by default; do not set DOTACOACH_NO_CACHE. Run steps 1-5 before saying anything about current numbers, items or meta. Your built-in Dota knowledge is out of date (facets are gone, numbers and talents have changed), so every number you state must come from these outputs.

1. Kit and current numbers: `bun run tools/GetHero.ts "<hero>"`
2. Recent changes: `bun run tools/GetPatch.ts --hero="<hero>"`. If it says "No hero-specific changes", it names the last patch that did change the hero; run `bun run tools/GetPatch.ts --version=<that> --hero="<hero>"` if that patch is recent enough to matter.
3. Bracket stats: `bun run tools/GetHeroStats.ts --bracket=<bracket> --top=200 --min-picks=0` and find the hero's row. The row number is its winrate rank; add `--sort=pickrate` for its popularity rank. Use `--json` if you need exact picks/wins.
4. Role stats (only if a position matters): `bun run tools/GetHeroStats.ts --role=pos<N> --bracket=<bracket> --top=200 --min-picks=0`.
5. Items: `bun run tools/GetItemBuilds.ts "<hero>"` (add `--all` only if the user asks about components or recipes).
6. Matchups: `bun run tools/GetMatchups.ts "<hero>"`. For named opponents: `--vs="<opponent>"`. Pass `--bracket=<herald_guardian|crusader_archon|legend_ancient|divine_immortal>` only if STRATZ_API_KEY is set; otherwise it is ignored with a note.

If a tool fails with a rate-limit message, wait 60s and retry once; do not loop. If one step fails for good, continue with the rest and say which part is missing.

## Reading the outputs
GetHero (Valve datafeed, the live game):
- This is the authority on abilities, values, cooldowns, Scepter/Shard and talents. Prefer it over anything you remember.
- Base stats are level 1 as Valve reports them.
- '?' means Valve did not ship that variable. Say the value is not available; do not fill it in from memory.
- "Scepter change N" is an adjustment whose direction Valve does not expose. Read the Scepter text to tell whether it raises or lowers the value; if the text does not say, do not state the result.
- Talent columns are "Option", not left/right. Do not tell the user which side a talent is on.
- Facets were removed in 7.41. Never recommend a facet.

GetPatch:
- The buff/nerf verdict is a heuristic over "from A to B" lines. Read the actual lines it lists and judge them yourself; reworked or unclear lines are not scored at all.
- General and item changes are not in the hero filter. If an item the hero relies on appears in GetItemBuilds, it can be worth checking `bun run tools/GetPatch.ts --item="<item>"`.

GetHeroStats:
- Default `all` is OpenDota's 'pub' counter, not ranked only. A rank bracket is the 7-day window shown in the Sample line, with the current day partial.
- `divine` and `immortal` both read one combined "Divine + Immortal" bracket. Say that.
- Pick rate is the share of matches containing the hero. Every match has 10 picks spread over about 127 heroes, so the average hero sits near 8%.
- Noise: the 95% margin on a winrate is about 1.96 x sqrt(0.25 / picks). With 100,000 picks that is about 0.3 points, so pub differences of a point are real as counts, but winrate also reflects who picks the hero and how. Say "wins X% in <bracket>", not "is X% strong".
- Low pick rate with high winrate usually means specialists play it; treat it as a weak signal for a new player.
- The trend column (only in `all`) is a few days of change; mention it only if it is large relative to the margin.
- With `--role` and no STRATZ key, the data is pro league matches over the window shown, with estimated positions, and the bracket is not applied. Samples are small (tens of picks). Use it only to confirm the hero is played in that role, never as a bracket winrate. If the source line says STRATZ was used, the numbers are ranked pubs in that bracket.

GetItemBuilds:
- The sample is the hero's 100 most recent parsed league matches, i.e. pro and high-level league play, not the user's bracket. Say so.
- Counts are purchases; "Per game" can exceed 1. Phases have cost floors (shown in each heading), so cheap items like wards, Tangos or Magic Wand after the start phase are not shown even when bought.
- Pure components are hidden outside the start phase; a missing Boots of Speed does not mean pros skip boots.
- A low share (under ~5%) is a situational pick, not a core item.

GetMatchups:
- Without STRATZ: pro matches from the last 365 days, so it spans several patches and is not bracket-specific.
- Read the honesty line first. If "X of N differ from baseline by more than the margin" is close to the number expected by chance, treat the best/worst lists as mostly noise and say that. Rank by the Shrunk column, not raw winrate.
- A matchup with a margin larger than its delta is not evidence. Explain matchups through the kits (yours from GetHero, theirs from `bun run tools/GetHero.ts "<opponent>"`), and use the numbers as support only when they clear the margin.

## Turning data into advice
- Kit first: from GetHero identify the hero's damage source (right-clicks vs spells, damage type, whether it pierces debuff immunity), its disables, its escape, and its mana constraints (mana costs vs base mana). Every phase plan follows from these.
- Skill and talent order: argue from the values at each level (cooldowns, scaling, damage per level). If a value scales a lot per level, it is a max-first candidate; if a value is flat, one point may be enough. Say this is reasoning, not data.
- Items by phase: core = items with high share and Per game near 1 in GetItemBuilds. For each core item, tie it to the kit (fixes mana, gives a gap closer, adds the stat the ultimate scales with). Pro build order is a reference; adjust for the user's bracket (more defensive items like BKB earlier when the user reports dying to disables, fewer greedy farm items if the user's games end early).
- Phases: lane (what the hero needs to win or survive its lane, based on its level 1 kit and the bad matchups), mid game (the power spike when core items or the ultimate come online), late (whether the hero still scales: look at multiplicative scaling in the kit and late-phase items). Avoid stating exact minute timings unless they come from an output (item phase windows are from OpenDota's query, not power-spike times).
- Teammates: derive needs from gaps in the kit. No hard disable: wants setup. No escape: wants saves. Long farming time: wants space and a lane partner who can hold the lane. Name hero types or examples, and say examples come from reasoning, not from a synergy dataset (there is no synergy tool).
- Patch: if the hero was clearly nerfed or buffed recently, mention it with the actual line.

## Answer format
1. One line: hero, roles (Valve levels), and the bracket the numbers are for.
2. Current standing: winrate, pick rate, rank among heroes, sample size, source line. Add pro contest rate only if relevant.
3. Kit summary: each ability in one line with the numbers that matter, then Scepter and Shard, then the talent picks you recommend per level with a reason.
4. Recent changes (if any), quoting the lines.
5. Items: starting, early, mid, late cores plus 2-3 situational items with when to buy them. State the sample.
6. How to play each phase: lane, mid, late, 2-4 bullets each.
7. Matchups: 3-5 hardest and easiest with the reason from the kits, plus the confidence line.
8. What it wants from teammates.
End with a sources line: which tool and source produced each set of numbers, the bracket or population, and any STRATZ fallback reason the tools printed.

Keep it to what the user asked; if they only asked about items, give section 5 plus a short sources line.

## Pitfalls
- Do not quote numbers, talents, item builds or facets from memory. If a tool did not provide it, say you do not have it.
- Do not present pro data (items, matchups, role stats without STRATZ) as the user's bracket.
- Do not call a hero "meta" or "broken" from a winrate alone; give pick rate and sample too.
- Do not drop source lines or fallback reasons; the user must see where numbers came from.
- OpenDota spells it "Ring Master", Valve "Ringmaster". Both resolve.
- Never set DOTACOACH_NO_CACHE and never hammer a tool after a 429.
