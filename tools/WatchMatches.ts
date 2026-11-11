import { intFlag, parseCli } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { loadProfile } from "../lib/profile.ts";
import { DEFAULT_GSI_PORT, GSI_CFG_NAME, Watcher, ensureGsiToken, gsiConfig, installGsi } from "../lib/watcher.ts";

const USAGE = `bun run tools/WatchMatches.ts [options]

Runs in the background while you play. When one of your saved accounts (tools/Profile.ts) finishes a
match, it asks OpenDota to parse the replay, waits for the parse, then writes a coaching review.
tools/Dashboard.ts does the same from a web page, plus account and GSI setup.

Triggers:
  (default)               listen for Dota 2 Game State Integration on 127.0.0.1:<port>. Instant: Dota
                          posts the match id the moment the game ends. Needs --install-gsi once.
  --poll=MIN              also check OpenDota every MIN minutes for new matches (works without GSI,
                          e.g. Dota on another PC; a match shows up a few minutes after it ends)
  --no-gsi                polling only

Setup:
  --install-gsi           write the GSI config into the Dota install, then exit
  --dota-dir=DIR          the "dota 2 beta" folder for --install-gsi (default: the usual Steam paths)
  --print-gsi-config      print the config file instead of writing it, then exit
  --port=N                GSI port (default ${DEFAULT_GSI_PORT})

After a match:
  --wait=MIN              how long to wait for OpenDota's parse (default 15)
  --no-parse              skip the parse request and review whatever OpenDota has
  --no-review             only request the parse
  --test=MATCH_ID         run the after-match steps once for MATCH_ID and exit

The review runs \`claude -p\` in the skill folder and is saved to reviews/<match_id>.md. Set
DOTACOACH_ON_MATCH to run your own command instead; it gets DOTACOACH_MATCH_ID, DOTACOACH_ACCOUNT_ID,
DOTACOACH_HERO and DOTACOACH_REVIEW_FILE in its environment.`;

const print = ({ at, text }: { at: number; text: string }) =>
  process.stdout.write(text.startsWith("\n") ? `${text}\n` : `[${new Date(at).toLocaleTimeString()}] ${text}\n`);

await main(async () => {
  const args = parseCli(USAGE, {
    strings: ["port", "poll", "wait", "test", "dota-dir"],
    booleans: ["install-gsi", "no-gsi", "no-parse", "no-review", "print-gsi-config"],
  });
  const port = intFlag(args.flags.port, "port", DEFAULT_GSI_PORT, 1024, 65535);
  const pollMin = args.flags.poll === undefined ? 0 : intFlag(args.flags.poll, "poll", 5, 1, 120);
  const token = ensureGsiToken();

  if (args.flags["print-gsi-config"]) {
    process.stdout.write(
      `# Save as <dota 2 beta>/game/dota/cfg/gamestate_integration/${GSI_CFG_NAME}\n` +
        "# and add -gamestateintegration to Dota's Steam launch options.\n\n" +
        gsiConfig(port, token),
    );
    return;
  }
  if (args.flags["install-gsi"]) {
    const dir = typeof args.flags["dota-dir"] === "string" ? args.flags["dota-dir"] : null;
    const file = installGsi(dir, port, token);
    process.stdout.write(
      `Wrote ${file}\n\n` +
        "Two more steps:\n" +
        "  1. Steam > Dota 2 > Properties > Launch Options: add  -gamestateintegration\n" +
        "  2. Restart Dota, then start the watcher: bun run tools/WatchMatches.ts\n",
    );
    return;
  }

  const watcher = new Watcher(
    {
      port,
      gsi: !args.flags["no-gsi"],
      pollMin,
      parse: !args.flags["no-parse"],
      review: !args.flags["no-review"],
      waitMin: intFlag(args.flags.wait, "wait", 15, 1, 60),
    },
    print,
  );

  if (typeof args.flags.test === "string") {
    const matchId = Number(args.flags.test);
    if (!Number.isInteger(matchId) || matchId <= 0) throw new DotaError(`--test needs a match id (got "${args.flags.test}").`);
    watcher.enqueue({ matchId, accountId: loadProfile().main?.account_id ?? 0, via: "test" }, true);
    await watcher.drain();
    return;
  }

  await watcher.start();
  watcher.log("Watching. Leave this window open while you play; Ctrl+C to stop.");
});
