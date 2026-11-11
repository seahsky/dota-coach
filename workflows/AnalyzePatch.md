# AnalyzePatch

Explain a Dota 2 patch: what changed, who got stronger or weaker, what it means for the meta and for the user's heroes.

## When to use
- "What changed in 7.41f?", "what's the latest patch?", "did my hero get nerfed?", "what's strong this patch?"
- The user is coming back after a break and wants to catch up on one or more patches.

Your built-in Dota knowledge is out of date (for example, facets were removed in 7.41 and lettered patches up to 7.41f exist). Do not state a patch number, a value, a buff/nerf or a meta claim until a tool has shown it in this session.

## Inputs
Ask only if missing and it changes the answer:
- **Version.** Default to the latest (GetPatch picks it). If they say "since I last played", ask roughly when, or use the patch dates in the output.
- **Their heroes** (optional, for the personal part). Names, nicknames or ids work.
- **Their bracket** (optional, for stats). Default to the public `all` bracket.

## Steps
Run from the skill directory (`cd ~/.claude/skills/DotaCoach`).

1. Patch overview: `bun run tools/GetPatch.ts [version]`
   - Note the version, release date, source line, and whether it says "This is the latest patch" or "Newer patches exist".
   - Big patches (over 150 note lines, e.g. 7.41) print a compact view. Drill in with `--section=general|heroes|items|neutral|creeps`, `--hero=<name>`, `--item=<full item name>` or `--full` (7.41 full is about 2,600 lines; avoid unless needed).
2. Per hero of interest: `bun run tools/GetPatch.ts [version] --hero=<name>`
   - If the hero was untouched, the output names the most recent earlier patch that changed it. Run that with `--version=<v> --hero=<name>` if relevant.
   - For "since I last played", run each version in the gap (versions are listed under "Newer patches exist" or in the 404 message) for the user's heroes.
3. Items the user cares about: `bun run tools/GetPatch.ts --item="<full name>"`. Item nicknames are not resolved ("bkb" fails; "Black King Bar" works). To learn which items matter for a hero, run `bun run tools/GetItemBuilds.ts "<hero>"`.
4. Current standing: `bun run tools/GetHeroStats.ts --top=200 --min-picks=0` (public), and if the user asked about a bracket, `--bracket=<rank>`. For pro meta: `--bracket=pro --sort=pickrate`. For a lane: `--role=pos1..pos5`.
5. Reworked or unclear heroes (listed under "Mostly reworked or unclear", or lines marked `(?)`): `bun run tools/GetHero.ts "<hero>"` to describe how the hero works now.

## Reading the outputs
**GetPatch**
- Source is the Valve datafeed. If the source line says OpenDota fallback, say so: OpenDota's patch notes stop at 7.41 and its dates cover major patches only, so lettered patches may be missing.
- Lines are tagged `(+)`, `(-)` or `(?)`. The "Buffs and nerfs (heuristic)" section is a text heuristic: direction from the verb and stat polarity, size from relative change, talents/sub-notes/Aghanim's lines down-weighted, and rescaled/replaced/reworked/new/removed lines not scored. Scores measure how much numbers moved, not game impact. Always read the driver lines before repeating a verdict.
- Known blind spots: a 50% change to a minor value outranks a 5% change to a core one; level-scaled changes like "70s to 100/85/70s" get averaged; whether a stat applies to the hero or to enemies is not modelled; talent swaps and "now"/"no longer" lines (often the most important) are unscored. "Mixed" and "unclear" mean read the lines yourself.
- "General" notes (map, objectives, mechanics, creeps) are not scored and can matter more than any single hero change.

**GetHeroStats**
- Window is the last 7 days of OpenDota daily buckets (current day partial). It shows the present only. No tool gives before/after patch stats.
- `all` is OpenDota's public counter (includes unranked and unknown-rank games), millions of matches, so a 1-point gap is real. `pro` is about 170 matches a week with a min-picks filter; treat single-hero pro winrates as noise and use pick and contest rate instead.
- Trend (only in `all`) = winrate change between days 4-6 and days 1-3 of the window, in points.
- `--role` without STRATZ is estimated from pro league matches over 30 days, not your bracket. Say so if you use it.

**GetHero**: current values from Valve. It cannot show old values; those come from the patch line's "from A to B".

**GetMatchups** covers 365 days of pro matches and spans many patches. Do not use it to show a patch effect.

**GetItemBuilds**: check the sample date range against the patch date before saying a build changed.

## Reasoning about before/after
Since APIs give only the current window:
1. Compare the patch date with today. If the patch is more than 7 days old and no newer patch exists, all GetHeroStats numbers are post-patch. If it is under 7 days old, the window mixes pre and post; the `all` Trend column is the only rough signal, and only if the patch fell between days 1-3 and 4-6.
2. Judge the hero's position now, relative to the field: a nerfed hero still in the top 10 by winrate with a high pick rate is still strong; a buffed hero still below 48% is probably still weak. Do not say "winrate went up/down" unless you measured it at two times.
3. Weigh change size against what the hero relies on (a cooldown on the core ultimate beats a talent tweak). Use GetHero to see which ability is central and what it does now.
4. Small lettered patches (a few dozen lines) rarely flip a hero's tier; a major patch with reworks can.
5. For the user's heroes, also check changes to their core items (from GetItemBuilds) and general mechanics changes that hit their role.
6. Pick rate often reacts faster than winrate: a hero that gains pick rate after a buff can show a lower winrate because less experienced players try it.

## Answer format
1. Header: version, release date, source (e.g. "7.41f, released 2026-09-15, Valve patch notes").
2. Big picture: 2-4 general or system changes that matter, quoted from the notes.
3. Biggest hero changes: buffs and nerfs with the actual from/to lines, your read of impact, and a note that ranking is heuristic.
4. Items: notable buffs/nerfs and who they affect.
5. Meta now: a few heroes with winrate/pick rate, naming the bracket, window and sample ("OpenDota public, last 7 days, 3.5M matches").
6. Your heroes: per hero, what changed (or "untouched since 7.41d"), current numbers, and what to do differently (skill build, item, playstyle).
7. Caveats in one or two lines: what the data cannot show.

Keep it tight. Quote numbers exactly as the tools printed them.

## Pitfalls
- Asserting old values or mechanics from memory (facets, old talent trees, removed items). Verify with GetPatch or GetHero.
- Presenting heuristic scores as facts, or as comparable across heroes.
- Mixing brackets without saying so, or using pro numbers for pub advice without noting the small sample.
- Claiming a patch caused a stat change. Without two snapshots, say "currently" not "now that".
- Forgetting earlier lettered patches: the latest patch may not include the change the user remembers.
- Item nicknames in `--item`; use the full item name.
