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

Restart Claude Code so it picks up the skill. Ask a Dota question ("what changed in the latest patch?", "how do I counter Pudge?") and Claude loads the skill on its own.

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
```

Add `--json` for structured output and `--help` to see every flag.

Typecheck (needs `bun install` first):

```bash
bun run typecheck
```

## Layout

```
SKILL.md      entry point Claude reads: when to use the skill, which tool and workflow
tools/        one CLI per data need (bun run tools/<Name>.ts)
workflows/    playbooks for each request type (patch, hero, meta, counter, draft, match)
lib/          API client, file cache, hero-name resolver, item names, STRATZ client
tests/        resolver tests and the live smoke test
```

## Cache and rate limits

Responses are cached in `~/.cache/dotacoach/` (or `$XDG_CACHE_HOME/dotacoach`). Hero and item constants are kept 24h, stats and patch notes 6h, parsed matches forever, and unparsed matches 1h so a later parse shows up. If an API is down or rate-limits you, the tools fall back to an expired cache entry and print a note. OpenDota's free tier allows about 60 requests per minute and 3,000 per day.

Environment variables (shell or `.env`):

| Variable | Effect |
| --- | --- |
| `STRATZ_API_KEY` | Enables the STRATZ data paths. |

Any of these can go in the skill folder's `.env` file instead of your shell.
| `DOTACOACH_NO_CACHE=1` | Skip the cache for this run. |
| `DOTACOACH_CACHE_DIR` | Use a different cache directory. |
| `DOTACOACH_DEBUG=1` | Print stack traces on unexpected errors. |

## Data caveats

- OpenDota's ability and talent constants lag the game, so `GetHero` reads Valve's `herodata` feed, which matches the live client.
- OpenDota's `/heroes/{id}/matchups` comes from pro league matches over the last 365 days. Samples are small, so `GetMatchups` shows a 95% margin and shrinks deltas toward the baseline.
- OpenDota never fills its Immortal bracket, so `--bracket=divine` and `--bracket=immortal` both read Divine and Immortal together.
- Without STRATZ, `GetHeroStats --role` estimates positions from OpenDota's pro-match explorer, so it covers pro games only.
- The STRATZ query shapes come from public code that uses the STRATZ API. They were not tested against the live API because no key was available during development. Any error or unexpected shape falls back to OpenDota.
