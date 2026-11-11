# Counterpick

Find heroes and items that beat one or more specific enemy heroes, and explain mechanically why they work.

## When to use
- "What counters X?", "who do I pick into X and Y?", "they have Z, what do I buy?", "I keep losing to X".
- Drafting (user has not picked yet) or itemizing (user already has a hero; skip to step 6).
- Not for a full hero guide (HeroBreakdown) or a game review (GetMatch).

Your built-in Dota knowledge is out of date (facets were removed in 7.41, values and talents have changed). Do not state a number, a matchup winrate or a "this hero counters X" claim until a tool has shown the supporting data or kit in this session.

## Inputs
Ask only for what is missing and changes the answer:
- **Enemy heroes** (required). Names, nicknames and ids resolve. If a tool says `Unknown hero ... Closest matches`, ask which one.
- **The user's position** (pos1-5) if they are picking. A counter they cannot play in their role is useless.
- **Their hero pool** (optional). If given, rank only those heroes, and check each one with `--vs`.
- **Their bracket** (optional). Used for GetHeroStats only; matchup data is not bracket-specific without STRATZ.
- **Already picked?** If yes, ask their hero and go to item counters.

## Steps
Run from the skill directory. The cache is on by default; never set DOTACOACH_NO_CACHE. On a rate-limit message, wait 60s and retry once. If a step fails for good, continue and say what is missing.

1. Enemy kits: `bun run tools/GetHero.ts "<enemy>"` for each enemy. Write down what each one relies on (see "Weakness checklist" below).
2. Enemy matchups: `bun run tools/GetMatchups.ts "<enemy>" --top=130 --json` for each enemy. `--top=130` returns the shown opponents ranked by `shrunkDelta`, split into a top half `best` (only rows with `shrunkDelta` > 0: enemy wins more) and a bottom half `worst` (only rows with `shrunkDelta` < 0: enemy wins less). Opponents near baseline that sit on the wrong side of their half are in neither list; check them with `--vs`. The `worst` list is the counter candidates. Without `--json`, the default `--top=8` markdown is enough for a single enemy.
3. Specific candidates (the user's pool, or heroes you suspect from the kits): `bun run tools/GetMatchups.ts "<enemy>" --vs="<candidate>"`. One hero per `--vs`. Below-threshold rows print "Below the --min-games=20 threshold; treat as noise".
4. Candidate kits: `bun run tools/GetHero.ts "<candidate>"` for the 3-6 strongest candidates. Confirm the mechanism with actual values (silence duration vs the enemy's escape cooldown, cast range vs the enemy's blink range, damage type vs the enemy's armor or magic resistance, debuff-immunity piercing).
5. Recent changes: `bun run tools/GetPatch.ts --hero="<hero>"` for the main enemy and each final candidate. A nerf to the counter's key ability or a buff to the enemy's escape can flip the answer, and the matchup data predates it.
6. Item counters: `bun run tools/GetItemBuilds.ts "<enemy>"` to see what the enemy relies on and in which phase (e.g. Black King Bar late, Blink Dagger mid). If the user's hero is known, `bun run tools/GetItemBuilds.ts "<user hero>"` shows which counter items that hero actually buys. For any item you recommend, `bun run tools/GetPatch.ts --item="<full item name>"` (nicknames like "bkb" do not resolve).
7. Viability in the user's games (only if picking): `bun run tools/GetHeroStats.ts --bracket=<bracket> --top=200 --min-picks=0` and find each candidate's row. For role fit, `--role=pos<N>`; without STRATZ that is estimated positions from recent pro league matches (the Sample line gives the window), not the user's bracket.

## Reading the outputs
GetMatchups:
- Numbers are from the enemy's side: `winrate` and `delta` are the enemy's. A good counter has a negative delta for the enemy. Rank by `shrunkDelta` (Shrunk pp), not raw winrate.
- Without STRATZ (source line says `STRATZ_API_KEY unset`, or `STRATZ fallback` plus a `Note: --bracket needs STRATZ_API_KEY` line when `--bracket` was passed without a key), the sample is pro matches from the last 365 days: several patches, not the user's bracket, and `--bracket` is ignored with a note. If the source line names STRATZ, the numbers are STRATZ bracket data; if it says it fell back, quote the reason.
- Read the honesty line first ("X of N shown matchups differ from baseline by more than the margin (about K expected by chance alone)"). If X is near K (Anti-Mage today: 1 of 77, about 4 expected), the lists are mostly noise. Say so and lean on mechanics.
- A row is evidence only when `significant` is true (|delta| > margin). Heroes below `--min-games` (default 20) are excluded from `best`/`worst`; check them with `--vs`.
- Matchup data is whole-game outcome. It cannot tell you whether the edge is in lane, in fights or late, or whether the counter was even in the same lane.

GetHero: the authority on the live kit. Use `Pierces debuff immunity`, damage type (Physical/Magical/Pure), `CD`, `Range`, durations and Scepter/Shard text. `?` means Valve did not ship the value; do not fill it from memory.

GetItemBuilds: the enemy's 100 most recent parsed league matches. If it notes the sample covers many days, older games may be from earlier patches. Per game near 1 means core; under about 5% share is situational. Phase headings give windows and cost floors (OpenDota's query), not power-spike times.

Items: no tool returns current item stats or descriptions. Describe item effects by mechanism (dispel, break, silence, heal reduction, evasion vs true strike) without quoting numbers, and say they come from general knowledge checked only for recent patch changes.

## Weakness checklist (enemy kit -> what beats it)
- Escape or mobility (blink, leap, invisibility): instant or long-range disables, roots/leashes, silence before they can cast, reveals for invisibility.
- Passive-dependent (bash, evasion, crit, lifesteal, auras): break effects.
- Buff- or save-dependent (shields, heals, ally saves): purges/dispels, heal reduction.
- Spell-reliant or mana-hungry: silence, mana burn, magic resistance, spell block.
- Physical right-click core with high armor or evasion: magical or pure damage, true strike, armor reduction.
- Illusions or summons: area damage, cleave.
- Channelled ultimate or long cast point: any interrupt with a shorter cooldown.
- Debuff immunity (Black King Bar in the enemy's GetItemBuilds, or a kit ability): prefer counters whose key ability shows `Pierces debuff immunity: yes`, or that win before the item timing.
- Weak lane (low base HP or armor, melee vs ranged, short attack range): a lane opponent with harass or kill threat, only if they actually share a lane.

## Turning data into advice
- Never recommend from winrate alone. Each pick needs a named mechanism from step 4, with the values from GetHero (e.g. the silence duration against the enemy escape's cooldown). Without one, drop it or label it "data only, mechanism unclear".
- Combine both sources: a statistically significant row plus a clear mechanism is a strong pick; a mechanism with no significant data is a reasonable pick (say the data is too thin); a significant row with no mechanism is a weak lead.
- Multiple enemies: score each candidate across every enemy. Prefer one that is a significant counter to the most dangerous enemy (usually their core) and is not a significant loser to any other enemy (enemy delta positive beyond the margin). One hero rarely counters a whole lineup; split jobs between the pick and items.
- Check the counter is not itself countered: run GetHero on the other enemies and look for what shuts down the candidate's mechanism (e.g. a silence-based counter into an enemy with dispels).
- Role fit: the counter must fit the user's position (step 7 `--role`). A lane counter only matters if they meet in lane.
- Bracket: if a candidate wins much less than average in the user's bracket, or has a very low pick rate there, flag that it may be hard to execute. Matchup data is pro play; mechanics that need coordination (setups, saves) are less reliable in pubs.
- Items: tie each item to an enemy dependency found in step 1 or step 6, and give the timing relative to the enemy's item phase (e.g. "before their Black King Bar shows up in the late phase").

## Answer format
1. One line per enemy: what it relies on (from GetHero).
2. Top 2-4 counter picks. For each: the mechanism with values, the matchup row (enemy winrate vs it, games, shrunk delta, whether it clears the margin), role fit, and any caveat (patch change, bracket viability, countered by another enemy).
3. Item counters: 2-4 items with the reason and timing, plus which ones the user's hero already buys if known.
4. How to play the matchup: 2-4 bullets on when to use the counter tool (e.g. save the silence for the escape, not the first cast).
5. Confidence: the honesty line per enemy, in plain words.
End with a sources line: which tool produced each set of numbers, the population (pro last 365 days, or STRATZ bracket), the GetHeroStats bracket, and any STRATZ fallback reason printed.

If the user only asked about items, give section 3 plus the sources line.

## Pitfalls
- Reading GetMatchups backwards. `best` is good for the enemy; your counters are in `worst`.
- Presenting pro matchup data as the user's bracket, or a 365-day sample as the current patch.
- Quoting ability numbers, talents or facets from memory. Facets do not exist anymore.
- Recommending a disable that does not pierce debuff immunity against an enemy that builds Black King Bar without saying it stops working then.
- Treating a noise-level list (honesty line near chance) as a ranking.
- Item nicknames in `--item` ("bkb", "nulli") fail; use full names.
- OpenDota spells it "Ring Master", Valve "Ringmaster". Both resolve.
