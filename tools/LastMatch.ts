import { TTL } from "../lib/cache.ts";
import { duration, intFlag, output, parseCli, sourceLine, table } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { heroName } from "../lib/heroes.ts";
import { opendota } from "../lib/http.ts";
import { getPlayerMatches, parseAndWait, playerWon, requestParse } from "../lib/players.ts";
import { accountName, loadProfile, parseAccountId, profileAccounts } from "../lib/profile.ts";

const USAGE =
  "bun run tools/LastMatch.ts [--account=<id|label|main>] [--count=N] [--parse] [--wait=MINUTES] [--json]\n" +
  "  Lists the newest matches across the saved main and alt accounts (tools/Profile.ts).\n" +
  "  --account  only this account (id, profile link, saved label, or 'main')\n" +
  "  --count    how many matches to list (default 5, max 20)\n" +
  "  --parse    ask OpenDota to parse the newest match if it is not parsed yet\n" +
  "  --wait     with --parse, wait up to this many minutes for the parse to finish (default 0: just request)";

interface Row {
  match_id: number;
  account_id: number;
  account: string;
  role: "main" | "alt" | "other";
  hero_id: number;
  hero: string;
  won: boolean;
  kda: string;
  start_time: number;
  ended_ago_min: number;
  duration: string;
  game_mode: string;
  parsed: boolean;
}

const prettyMode = (name: string | undefined) =>
  name ? name.replace("game_mode_", "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : null;

function ago(min: number): string {
  if (min < 90) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

await main(async () => {
  const args = parseCli(USAGE, { strings: ["account", "count", "wait"], booleans: ["parse"] });
  const count = intFlag(args.flags.count, "count", 5, 1, 20);
  const waitMin = intFlag(args.flags.wait, "wait", 0, 0, 60);
  const profile = loadProfile();
  let accounts = profileAccounts(profile).map((a) => ({ id: a.account_id, name: accountName(a), role: a.role as Row["role"] }));

  const pick = typeof args.flags.account === "string" ? args.flags.account.trim() : undefined;
  if (pick) {
    const byLabel = accounts.filter((a) =>
      pick.toLowerCase() === "main" ? a.role === "main" : a.name.toLowerCase() === pick.toLowerCase(),
    );
    if (byLabel.length) accounts = byLabel;
    else {
      const id = parseAccountId(pick);
      accounts = [accounts.find((a) => a.id === id) ?? { id, name: String(id), role: "other" }];
    }
  }
  if (!accounts.length) {
    throw new DotaError(
      "No accounts saved. Ask the user for their Dota Friend ID and run: bun run tools/Profile.ts set-main <account>. " +
        "Or pass --account=<id> for a one-off lookup.",
    );
  }

  const [modes, perAccount] = await Promise.all([
    opendota<Record<string, { name: string }>>("/constants/game_mode", { ttl: TTL.constants }),
    Promise.all(accounts.map(async (a) => ({ a, matches: await getPlayerMatches(a.id, count) }))),
  ]);

  const now = Date.now() / 1000;
  const rows: Row[] = [];
  for (const { a, matches } of perAccount) {
    for (const m of matches) {
      rows.push({
        match_id: m.match_id,
        account_id: a.id,
        account: a.name,
        role: a.role,
        hero_id: m.hero_id,
        hero: await heroName(m.hero_id),
        won: playerWon(m),
        kda: `${m.kills}/${m.deaths}/${m.assists}`,
        start_time: m.start_time,
        ended_ago_min: Math.max(0, Math.round((now - m.start_time - m.duration) / 60)),
        duration: duration(m.duration),
        game_mode: prettyMode(modes[String(m.game_mode)]?.name) ?? `Mode #${m.game_mode}`,
        parsed: Boolean(m.version),
      });
    }
  }
  rows.sort((x, y) => y.start_time - x.start_time);
  const shown = rows.slice(0, count);
  if (!shown.length) throw new DotaError("OpenDota has no matches for these accounts. Is Expose Public Match Data on?");

  const latest = shown[0]!;
  let parse: { requested: boolean; result: string } | null = null;
  if (args.flags.parse && !latest.parsed) {
    if (waitMin > 0) {
      const r = await parseAndWait(latest.match_id, waitMin * 60_000, (s) => process.stderr.write(`${s}\n`));
      latest.parsed = r === "parsed";
      parse = { requested: true, result: r === "parsed" ? "parsed" : `not parsed after ${waitMin} min` };
    } else {
      const job = await requestParse(latest.match_id);
      parse = { requested: Boolean(job), result: job ? `queued (job ${job}); usually done in 1-5 min` : "OpenDota does not have the match yet; retry in a few minutes" };
    }
  }

  output(args, { latest, matches: shown, parse }, () =>
    [
      `Latest: match ${latest.match_id} on ${latest.account} (${latest.role}), ${latest.hero}, ${latest.won ? "won" : "lost"} ${latest.kda}, ended ${ago(latest.ended_ago_min)}, ${latest.parsed ? "parsed" : "not parsed"}.`,
      parse ? `Parse request: ${parse.result}.` : "",
      "",
      table(
        ["Match", "Account", "Hero", "Result", "K/D/A", "Length", "Mode", "Ended", "Parsed"],
        shown.map((r) => [r.match_id, r.account, r.hero, r.won ? "Win" : "Loss", r.kda, r.duration, r.game_mode, ago(r.ended_ago_min), r.parsed ? "yes" : "no"]),
        ["l", "l", "l", "l", "r", "r", "l", "l", "l"],
      ),
      "",
      sourceLine("OpenDota /players/{id}/matches", "a game appears a few minutes after it ends; cached 2 min"),
    ]
      .filter((l, i, a) => l !== "" || a[i - 1] !== "")
      .join("\n"),
  );
});
