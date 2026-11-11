# DotaCoach

A Claude Code skill that turns Claude into a Dota 2 coach. Claude pulls live data before giving advice. Patch notes come from Valve's datafeed. Hero stats, matchups, items and matches come from OpenDota. STRATZ is optional and adds ranked per-position stats and bracket-specific matchups.

## Setup

1. Install Bun (developed and tested with Bun 1.4):

   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. Install the skill as a personal skill:

   ```bash
   git clone https://github.com/seahsky/dota-coach.git ~/.claude/skills/DotaCoach
   ```

   If you already have a clone elsewhere, symlink it instead:

   ```bash
   ln -s /path/to/dota-coach ~/.claude/skills/DotaCoach
   ```

   The tools have no runtime dependencies, so there is no install step. Run `bun install` only if you want to typecheck.

3. Optional: set a STRATZ key. Get a token at stratz.com/api, then copy the example env file and paste the token in:

   ```bash
   cp ~/.claude/skills/DotaCoach/.env.example ~/.claude/skills/DotaCoach/.env
   ```

   ```
   STRATZ_API_KEY=your-token
   ```

   The tools read this `.env` from the skill folder wherever they are run from, and git ignores it. A `STRATZ_API_KEY` exported in your shell takes precedence over the file.

   Without it, every tool still works on OpenDota and says so in its source line. With it, `GetHeroStats --role` uses STRATZ ranked per-position data and `GetMatchups` uses STRATZ matchups, with `--bracket` support. If a STRATZ call fails, the tool falls back to OpenDota and prints the reason.

4. Set up your accounts and the post-game watcher in the dashboard:

   ```bash
   bun run ~/.claude/skills/DotaCoach/tools/Dashboard.ts
   ```

   It opens `http://127.0.0.1:3743/?t=<code>` in your browser and prints that link in the terminal. Only that link works, and the code changes every run, so other programs and users on the PC can't use the page. There you add your main account and alts (Friend ID or a profile link), write coaching notes, connect Dota 2, start the watcher, paste a STRATZ token, and read saved reviews. Everything is stored in the skill folder: accounts, notes and watcher settings in `profile.json`, the STRATZ key in `.env`; git ignores both. The page only listens on your computer.

   You can skip the dashboard: tell Claude "my Dota account is <Friend ID>" and it saves it with `tools/Profile.ts`, or run that yourself:

   ```bash
   bun run tools/Profile.ts set-main <friend-id>
   ```

Restart Claude Code so it picks up the skill. Ask a Dota question ("what changed in the latest patch?", "how do I counter Pudge?") and Claude loads the skill on its own.

## Match map

Every match in the dashboard's list has a **Map** button, and **View review** opens the same map above the review. For a parsed replay it draws:

- observer and sentry wards for both teams, with a strike-through on wards cleared early (hover for who placed it, when, and who cleared it)
- deaths that happened in teamfights (OpenDota only records positions for those), and teamfight centres
- your early-game lane position, your lane opponent's, and where all heroes walked
- coach marks: where to ward, where to sentry, where to stand and which spots got you killed, saved by the review

Drag the time slider or press Play to see which wards were up at each moment. Reviews written by the watcher save the coach marks automatically; in a conversation, ask Claude to review a match and it saves them too. The marks live in `reviews/<match_id>.map.json`.

The river and mid lane are drawn roughly; ward, death and lane positions are the recorded ones. Without a parsed replay there is nothing to draw.

## Updating

The dashboard updates the skill when it starts: it checks GitHub and installs a newer version before the page opens. While it runs it checks again every 6 hours and shows an **Update now** banner. Turn automatic updates off in the page's Updates section, or skip one run with `--no-update`.

Without the dashboard:

```bash
bun run tools/Update.ts
```

Updates only fast-forward the skill's own files. Your `profile.json`, `.env` and `reviews/` are git-ignored and never touched. If you edited the skill's files yourself, or the branch you cloned was merged and deleted on GitHub, the update stops and tells you what to do instead. After an update, start a new Claude Code session so it reads the new instructions.

## Automatic review after each game

OpenDota and STRATZ have no webhooks. The instant signal comes from Dota itself: Game State Integration posts game state to a local URL, including the match id when the game ends. `tools/WatchMatches.ts` listens for that, asks OpenDota to parse the replay, then runs `claude -p` to review the match and saves the result to `reviews/<match_id>.md`. Expect the review a few minutes after the game: the trigger is instant, the OpenDota parse takes 2-10 minutes, the review about a minute.

The dashboard (`tools/Dashboard.ts`) walks through this: it installs the config into your Dota folder, runs the watcher, shows when Dota last checked in, and lists your recent matches with their reviews. Keep it open while you play.

Without the dashboard, on the PC that runs Dota:

```bash
bun run tools/WatchMatches.ts --install-gsi
```

Add `-gamestateintegration` to Dota's launch options in Steam and restart Dota. Then before you play:

```bash
bun run tools/WatchMatches.ts
```

Add `--poll=5` to also check OpenDota every 5 minutes, which catches games played on another PC. `--help` lists every option, including `--test=<match_id>` for a dry run and `DOTACOACH_ON_MATCH` to run your own command instead of Claude. Valve notes GSI can cost some frame rate; remove the launch option to turn it off.

## Testing

From the skill directory:

```bash
bash tests/smoke.sh
```

This runs each tool once against the live APIs and checks the error paths (unknown hero, ambiguous hero, bad match id, bad patch version, bad bracket). It needs network access to api.opendota.com and www.dota2.com.

```bash
bun test
```

This runs the hero-name resolver tests (nicknames, typos, ambiguity). The first run fetches the hero list from OpenDota; later runs use the cache.

Try individual tools:

```bash
bun run tools/GetHero.ts am
bun run tools/GetMatchups.ts "pudge"
bun run tools/GetHeroStats.ts --bracket=legend --role=pos4 --top=10
bun run tools/GetPatch.ts --hero=pudge
bun run tools/GetItemBuilds.ts qop
bun run tools/GetMatch.ts <match_id> --draft
bun run tools/ReplayMap.ts <match_id> --hero=slardar
bun run tools/Profile.ts
bun run tools/LastMatch.ts --count=5
```

Add `--json` for structured output and `--help` to see every flag.

Typecheck (needs `bun install` first):

```bash
bun run typecheck
```

## Layout

```
SKILL.md      entry point Claude reads: when to use the skill, which tool and workflow
tools/        one CLI per data need (ReplayMap prints map positions) (bun run tools/<Name>.ts), plus Dashboard and WatchMatches
dashboard/    the setup page served by tools/Dashboard.ts
workflows/    playbooks for each request type (patch, hero, meta, counter, draft, match, auto review)
lib/          API client, file cache, hero-name resolver, item names, STRATZ client
tests/        resolver tests and the live smoke test
profile.json  your accounts and notes (created by tools/Profile.ts, git-ignored)
reviews/      post-game reviews and their map marks (<id>.map.json), git-ignored
```

## Cache and rate limits

Responses are cached in `~/.cache/dotacoach/` (or `$XDG_CACHE_HOME/dotacoach`). Hero and item constants are kept 24h, stats and patch notes 6h, parsed matches forever, and unparsed matches 1h so a later parse shows up. If an API is down or rate-limits you, the tools fall back to an expired cache entry and print a note. OpenDota's free tier allows about 60 requests per minute and 3,000 per day.

Environment variables (shell or `.env`):

| Variable | Effect |
| --- | --- |
| `STRATZ_API_KEY` | Enables the STRATZ data paths. |
| `DOTACOACH_NO_CACHE=1` | Skip the cache for this run. |
| `DOTACOACH_CACHE_DIR` | Use a different cache directory. |
| `DOTACOACH_PROFILE` | Use a different profile file instead of `profile.json` in the skill folder. |
| `DOTACOACH_ON_MATCH` | Command the watcher runs after a game instead of `claude -p`. A command saved in the dashboard (stored in `profile.json`) takes precedence. |
| `DOTACOACH_DEBUG=1` | Print stack traces on unexpected errors. |

Any of these can go in the skill folder's `.env` file instead of your shell.

## Data caveats

- OpenDota's ability and talent constants lag the game, so `GetHero` reads Valve's `herodata` feed, which matches the live client.
- OpenDota's `/heroes/{id}/matchups` comes from pro league matches over the last 365 days. Samples are small, so `GetMatchups` shows a 95% margin and shrinks deltas toward the baseline.
- OpenDota never fills its Immortal bracket, so `--bracket=divine` and `--bracket=immortal` both read Divine and Immortal together.
- Without STRATZ, `GetHeroStats --role` estimates positions from OpenDota's pro-match explorer, so it covers pro games only.
- The STRATZ query shapes come from public code that uses the STRATZ API. They were not tested against the live API because no key was available during development. Any error or unexpected shape falls back to OpenDota.
