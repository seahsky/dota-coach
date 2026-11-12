import { output, parseCli } from "../lib/cli.ts";
import { main } from "../lib/errors.ts";
import { applyUpdate, checkForUpdate } from "../lib/update.ts";

const USAGE = `bun run tools/Update.ts [--check] [--json]
  Updates the skill to the newest version on GitHub (git fast-forward only).
  Your profile.json, .env and reviews/ are git-ignored and never touched.
  --check   only report whether an update is available`;

await main(async () => {
  const args = parseCli(USAGE, { booleans: ["check"] });
  if (args.flags.check) {
    const s = await checkForUpdate();
    if (s.state === "blocked" || s.state === "unavailable") process.exitCode = 1;
    return output(args, s, () => [s.message, ...s.incoming.map((x) => `  - ${x}`)].join("\n"));
  }
  const r = await applyUpdate();
  if (r.error || r.status.state === "blocked" || r.status.state === "unavailable") process.exitCode = 1;
  return output(args, r, () =>
    [
      r.error ? `Update failed: ${r.error}` : r.status.message,
      ...(r.updated ? r.status.incoming.map((x) => `  - ${x}`) : []),
      r.updated ? "Restart the dashboard or watcher, and start a new Claude Code session, to use the new version." : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
});
