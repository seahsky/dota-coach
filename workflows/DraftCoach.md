# DraftCoach

Recommend the next pick for a partially drafted game ("we have X, Y; they have A, B, C; what do we pick pos 4?") and explain the plan each pick implies.

## When to use
- Mid-draft questions with heroes on both sides, or "what does our lineup need?".
- Not for a single-hero counter question with no draft context (Counterpick), a hero guide (HeroBreakdown) or a finished game (GetMatch).

Your built-in Dota knowledge is out of date (facets were removed in 7.41, values, talents and the meta have changed). Do not state a number, a winrate, a meta claim or what an ability does until a tool has shown it in this session. Draft theory (lanes, damage mix, win conditions) is yours; the hero facts behind it must come from GetHero.

## Inputs
Ask only for what is missing and changes the answer. If the user gave enough to start, start, and state your assumptions.
- **Allied and enemy heroes** (required). Names, nicknames and ids resolve. On `Unknown hero ... Closest matches`, ask.
- **Position to fill** (required). If not given, infer it from the open positions after step 3 and say so.
- **Known positions** of picked heroes (optional). Otherwise infer them in step 3.
- **Bans** (optional). Removed from candidates; a banned enemy hero also tells you what they feared.
- **Pick order / picks left** (optional). If we pick before their last picks, prefer flexible or safe picks over hard counters.
- **Bracket and hero pool** (optional). The pool limits candidates; the bracket is used only for GetHeroStats without `--role`.

## Steps
Run from the skill directory. The cache is on by default; never set DOTACOACH_NO_CACHE. On a rate-limit message, wait 60s and retry once. If a step fails for good, continue and say what is missing.

1. Kits: `bun run tools/GetHero.ts "<hero>"` for every picked hero on both sides. Note per hero: Valve roles and levels, damage type of each ability, disables (type, duration, `Pierces debuff immunity`), saves and sustain, mobility, push tools (summons, illusions, wave clear), Scepter and Shard text.
2. Recent changes: `bun run tools/GetPatch.ts --hero="<hero>"` for the enemy cores and for your final candidates. It says whether the latest patch touched the hero and which earlier patch last did.
3. Positions: `bun run tools/GetHeroStats.ts --role=pos<N> --sort=pickrate --top=200 --min-picks=0 --json` for N = 1..5. All five share one cached explorer query. For each picked hero, its `pickrate` per position shows where pros currently play it. Use it to assign likely positions to heroes the user did not place, and to see which positions each side still has open.
4. Candidate pool: the same pos<N> output for the position you are filling, sorted by pickrate, gives heroes actually played there. Merge with the user's pool and with heroes your reasoning in "Draft reasoning" calls for. Drop bans and picked heroes. Keep 6-10 candidates; run GetHero on each one you have not seen yet.
5. Matchups: `bun run tools/GetMatchups.ts "<enemy>" --top=130 --json` for each enemy hero. `best` holds the top half of opponents above `--min-games` (default 20) with `shrunkDelta` > 0, and `worst` the bottom half with `shrunkDelta` < 0, so opponents close to baseline can be in neither list. For a candidate below the threshold or missing from both lists, `bun run tools/GetMatchups.ts "<enemy>" --vs="<candidate>"` (one per call) and treat it as noise.
6. Role viability: from step 3's JSON for your position, read each candidate's `picks`, `winrate` and `pickrate`. For the user's bracket overall, `bun run tools/GetHeroStats.ts --bracket=<bracket> --top=200 --min-picks=0` and find the candidate rows.
7. Optional, for the final 1-2 picks: `bun run tools/GetItemBuilds.ts "<hero>"` to show what the pick usually builds and when, if the plan depends on an item (Blink Dagger, Black King Bar, Aghanim's Scepter).

## Reading the outputs
- GetHero is the authority on kits. `?` means Valve did not ship the value; do not fill it from memory. Roles are Valve's 1-3 levels.
- GetHeroStats `--role` without STRATZ: positions are estimated from farm at 10-12 min, lane and early wards, using pro league matches from the last 30 days (`--days` changes it). `--bracket` is not applied there. Per-position samples are small: below about 20 picks treat winrate as noise and use pickrate only as "is this played here". If the source line names STRATZ, it is ranked pub data for that bracket; if it says it fell back, quote the reason.
- GetHeroStats without `--role`: OpenDota last 7 days for that bracket, no position split. Divine and Immortal are one combined bracket.
- GetMatchups numbers are from the queried enemy's side. For candidate C against enemy E, C's edge is the negative of E's `shrunkDelta` for C. `significant` true means |delta| beats the 95% margin. Without STRATZ the sample is pro matches from the last 365 days, several patches, whole-game results only. Read `significantCount` against the chance level in the markdown honesty line; if they are close, the list is mostly noise.
- No tool gives hero synergy (ally pairs), lane matchups by lane, or item stats. Synergy comes from kit reasoning, labelled as such.

## Draft reasoning (do this before looking at winrates)
Work through these with the kits from step 1. Write one line per point for the current draft.
1. Lanes: by position, pos1+pos5 face their pos3+pos4, pos2 faces pos2, pos3+pos4 face their pos1+pos5. Ask what the open position's lane needs: kill threat and stuns to pressure their carry, or sustain and safety to protect ours. A ranged support with harass is worth more against a melee lane than a ranged one.
2. Damage type: count Physical vs Magical vs Pure across our heroes' main damage. If one type dominates, enemy armor or magic resistance items or heroes shut it down; prefer a pick that adds the missing type.
3. Disables and catch: list our reliable disables (duration, range, cast point if shown, debuff-immunity piercing). Against escape or blink heroes, we need instant or long-range catch. Against enemies that will build Black King Bar (check GetItemBuilds for their cores), favour piercing disables or an earlier timing.
4. Saves and sustain: does our core have a save (dispel, invulnerability, heal, displacement)? Does the enemy rely on burst we can deny, or on sustain we can cut?
5. Push and defend: who takes towers (summons, illusions, siege damage, wave clear) and who stops a push? A lineup with no wave clear loses to fast pushers.
6. Timing and win condition: name ours and theirs. Early fight/push lineups need a pick that fights from minute 0 and helps take towers; late lineups need a pick that buys time (saves, wave clear, defensive disables). Do not mix a greedy pick into an early lineup without saying why.
7. Roshan and vision: who can take Roshan early (physical damage, armor reduction, summons)? Who controls vision (invisibility reveals, wards, global presence)? A smoke-and-gank lineup needs initiation; a Roshan lineup needs to fight in the pit.
8. What the enemy still needs: list their open positions and missing pieces (a stun, a save, wave clear, a carry). Name 2-4 likely picks (from step 3 pickrates at their open positions) and prefer a pick that is not hard countered by those, or that removes their best option.

## Turning data into a shortlist
- Score each candidate on the draft points first: which gaps it fills, which enemy weaknesses it uses, and how it fits our win condition. Discard candidates that fill no gap.
- Then add matchup evidence: for each candidate, sum its edge (negative enemy `shrunkDelta`) over the enemy heroes and list the significant rows. The rows share matches and are not independent, so the sum is a rough tiebreak, never a winrate. Weight the enemy core you will actually fight most.
- Then role viability: a candidate with near-zero pickrate at that position in step 3, or a clearly low winrate in the user's bracket, needs a stated reason (pool, specific counter) to stay.
- If a pick is good only with an item or level timing, say so (from GetItemBuilds phases, which are purchase windows, not power spikes).
- If we pick before their remaining picks, prefer candidates with no significant losing row against the likely enemy picks.

## Answer format
1. Draft read (3-6 lines): positions assumed, our win condition, theirs, our gaps, their likely next picks.
2. Shortlist of 2-4 ranked picks. For each:
   - What it fills (lane, damage type, disable, save, push, Roshan, vision), with kit values from GetHero.
   - Matchup evidence: summed edge, significant rows (enemy winrate vs it, games), or "data too thin".
   - Role viability: picks and pickrate at the position, bracket winrate if run.
   - The plan it implies: lane and partner, the timing to fight or push, Roshan, what to avoid.
   - Caveats: recent patch change, what the enemy can pick to answer it.
3. Avoid (optional, 1-3 heroes): picks that look tempting but fail a draft point or have a significant losing row.
4. Sources line: each tool and population used (pro matchups last 365 days, pro estimated positions last N days, bracket stats last 7 days), and any STRATZ fallback reason printed.

## Pitfalls
- Ranking by matchup winrate before the draft reasoning. Winrates are a tiebreak.
- Reading GetMatchups backwards: the enemy's `best` list contains heroes that do badly against them.
- Presenting pro data as the user's bracket, or a 365-day sample as the current patch.
- Assuming lanes from hero names. Use the user's positions or step 3 pickrates and state the assumption.
- Claiming synergy or a counter without a mechanism from GetHero.
- Quoting ability numbers, talents or facets from memory. Facets do not exist anymore.
- Item nicknames in `--item` fail; use full names. "Ring Master" (OpenDota) and "Ringmaster" (Valve) both resolve.
