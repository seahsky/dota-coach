import { output, parseCli, sourceLine, table } from "../lib/cli.ts";
import { DotaError, main } from "../lib/errors.ts";
import { PROFILE_FILE, type Account, loadProfile, parseAccountId, profileAccounts, saveProfile } from "../lib/profile.ts";
import { getPlayer, rankName } from "../lib/players.ts";

const USAGE = `bun run tools/Profile.ts [command] [--label=NAME] [--json]

Commands:
  show                      (default) list the saved main and alt accounts with current rank
  set-main <account>        save the user's main account
  add-alt <account>         add an alt / smurf account
  remove <account>          remove an account (main or alt)
  note "<text>"             save coaching notes (preferred roles, goals); "note" alone clears them

<account> is the Dota Friend ID, a Steam64 id, or an opendota/dotabuff/stratz/steamcommunity profile link.`;

async function verify(id: number, label?: string): Promise<Account> {
  const p = await getPlayer(id);
  return { account_id: id, ...(label ? { label } : {}), persona: p.profile?.personaname ?? undefined };
}

await main(async () => {
  const args = parseCli(USAGE, { strings: ["label"] });
  const [cmd = "show", ...rest] = args.positionals;
  const label = typeof args.flags.label === "string" ? args.flags.label.trim() || undefined : undefined;
  const profile = loadProfile();
  let changed = "";

  switch (cmd) {
    case "show":
      break;
    case "set-main": {
      if (!rest[0]) throw new DotaError(`set-main needs an account.\nUsage: ${USAGE}`);
      const acc = await verify(parseAccountId(rest[0]), label ?? "main");
      profile.alts = profile.alts.filter((a) => a.account_id !== acc.account_id);
      if (profile.main && profile.main.account_id !== acc.account_id) {
        changed = `Main set to ${acc.persona ?? acc.account_id}. Previous main ${profile.main.account_id} kept as an alt.`;
        profile.alts.push({ ...profile.main, label: profile.main.label === "main" ? "old main" : profile.main.label });
      } else {
        changed = `Main set to ${acc.persona ?? acc.account_id}.`;
      }
      profile.main = acc;
      break;
    }
    case "add-alt": {
      if (!rest[0]) throw new DotaError(`add-alt needs an account.\nUsage: ${USAGE}`);
      const id = parseAccountId(rest[0]);
      if (profile.main?.account_id === id) throw new DotaError(`${id} is already the main account.`);
      const acc = await verify(id, label);
      profile.alts = [...profile.alts.filter((a) => a.account_id !== id), acc];
      changed = `Alt ${acc.persona ?? id} saved.`;
      break;
    }
    case "remove": {
      if (!rest[0]) throw new DotaError(`remove needs an account.\nUsage: ${USAGE}`);
      const id = parseAccountId(rest[0]);
      const before = profileAccounts(profile).length;
      if (profile.main?.account_id === id) delete profile.main;
      profile.alts = profile.alts.filter((a) => a.account_id !== id);
      if (profileAccounts(profile).length === before) throw new DotaError(`${id} is not in the profile.`);
      changed = `Removed ${id}.`;
      break;
    }
    case "note": {
      const text = rest.join(" ").trim();
      if (text) profile.notes = text;
      else delete profile.notes;
      changed = text ? "Notes saved." : "Notes cleared.";
      break;
    }
    default:
      throw new DotaError(`Unknown command "${cmd}".\nUsage: ${USAGE}`);
  }

  // Refresh persona and rank for display; a failed lookup should not hide the saved profile.
  const rows = await Promise.all(
    profileAccounts(profile).map(async (a) => {
      try {
        const p = await getPlayer(a.account_id);
        a.persona = p.profile?.personaname ?? a.persona;
        return { ...a, rank: rankName(p.rank_tier, p.leaderboard_rank), rank_tier: p.rank_tier ?? null, error: null };
      } catch (err) {
        return { ...a, rank: null, rank_tier: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  if (changed) {
    for (const r of rows) {
      const target = r.role === "main" ? profile.main : profile.alts.find((x) => x.account_id === r.account_id);
      if (target && r.persona) target.persona = r.persona;
    }
    saveProfile(profile);
  }

  output(args, { file: PROFILE_FILE, changed: changed || null, accounts: rows, notes: profile.notes ?? null }, () => {
    const lines: string[] = [];
    if (changed) lines.push(changed, "");
    if (!rows.length) {
      lines.push(
        "No accounts saved yet. Ask the user for their Dota Friend ID (or an opendota/dotabuff/stratz profile link), then run:",
        "  bun run tools/Profile.ts set-main <account>",
      );
    } else {
      lines.push(
        table(
          ["Role", "Account", "Label", "Steam name", "Rank"],
          rows.map((r) => [r.role, r.account_id, r.label ?? "", r.persona ?? "", r.rank ?? (r.error ? "lookup failed" : "unranked")]),
        ),
      );
      for (const r of rows) if (r.error) lines.push(`- ${r.account_id}: ${r.error}`);
    }
    if (profile.notes) lines.push("", `Notes: ${profile.notes}`);
    lines.push("", sourceLine("OpenDota /players", `profile file ${PROFILE_FILE}`));
    return lines.join("\n");
  });
});
