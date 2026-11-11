# AutoReview

Set up automatic post-game reviews: the user plays, the game ends, and a review of that match is waiting a few minutes later without them asking.

## When to use
- "Review my games automatically", "can you give me feedback right after each game?", "set up the watcher", "is there a webhook for my matches?"
- Not for reviewing one match now (MatchAnalysis).

## How it works (tell the user this briefly)
Neither OpenDota nor STRATZ offers webhooks, and Valve's Web API has none either. The push signal comes from the Dota 2 client: **Game State Integration (GSI)**. With the `-gamestateintegration` launch option and a config file in the game folder, Dota POSTs game state to a local URL. `tools/WatchMatches.ts` listens on `127.0.0.1:3742`. When the state reaches post-game for one of the saved accounts, it:
1. asks OpenDota to parse the replay (`POST /request/{match_id}`) and waits until the parse finishes (usually 2-10 minutes, up to `--wait`, default 15);
2. runs `claude -p` in the skill folder to review the match with MatchAnalysis, focused on the user's player;
3. prints the review in the watcher window and saves it to `reviews/<match_id>.md`.

The slow part is OpenDota parsing the replay, not the trigger. GSI only reports the local player, so it never fires for spectated games or other people.

Fallback without GSI (Dota on a different machine than Claude Code, or the user does not want the launch option): `--poll=5` checks OpenDota every 5 minutes. A match appears on OpenDota a few minutes after it ends, so this adds about 5-10 minutes.

## Easiest path: the dashboard
Tell the user to run this on the PC they play on, open the link it prints (it ends in `?t=` and a code; only that link works), and follow the page top to bottom (accounts, Connect Dota 2, Post-game reviews):
```
bun run tools/Dashboard.ts
```
It installs the GSI config, shows a "Signal from Dota" light that turns green once Dota checks in, runs the watcher while the page's terminal stays open, and lists reviews. Use the CLI steps below only if they prefer the terminal or the dashboard cannot run.

## CLI steps
1. `bun run tools/Profile.ts`. If no main account is saved, get it first (SKILL.md "Who the user is"). Add any alts they play on: GSI ignores accounts that are not in the profile.
2. Install the GSI config. This must run on the PC that runs Dota:
   ```
   bun run tools/WatchMatches.ts --install-gsi
   ```
   If it cannot find the install, ask for the `dota 2 beta` folder (Steam: Dota 2 > Manage > Browse local files) and pass `--dota-dir="<folder>"`. If Claude Code is in WSL and Dota on Windows, the folder is under `/mnt/c/...`; WSL2 forwards `127.0.0.1` from Windows by default.
3. Tell the user to add `-gamestateintegration` to Dota's Steam launch options (Steam: Dota 2 > Properties > General > Launch Options) and restart Dota. Valve has said GSI can cost some frame rate; removing the launch option turns it off.
4. Tell the user to start the watcher in its own terminal before playing and leave it open:
   ```
   bun run tools/WatchMatches.ts
   ```
   Add `--poll=5` to also catch games played elsewhere. Do not start it yourself in this conversation; it runs until stopped.
5. Optional test with a past match: `bun run tools/WatchMatches.ts --test=<match_id>` runs the parse and review once.

## Options worth mentioning
- `--no-review`: only request parses, so data is ready when they ask Claude later.
- An after-match command (dashboard section 5, or `DOTACOACH_ON_MATCH` in the shell or `.env`): run their own command (a Discord webhook, a notification) instead of `claude -p`. It gets `DOTACOACH_MATCH_ID`, `DOTACOACH_ACCOUNT_ID`, `DOTACOACH_HERO`, `DOTACOACH_REVIEW_FILE` in the environment.
- Each review is a full Claude Code run and uses the user's Claude usage like any other prompt.

## Pitfalls
- Practice lobbies, bot games and arcade games never reach OpenDota; the watcher gives up after `--wait` and logs it.
- "Expose Public Match Data" must be on in Dota (Settings > Options > Social), or OpenDota has no data for the account.
- The GSI config holds a random token from `profile.json`; the watcher rejects posts without it. If the user deletes `profile.json`, rerun `--install-gsi`.
