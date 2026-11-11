import "./env.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DotaError } from "./errors.ts";

/**
 * Who the user is: their main Dota account and any alts. Stored next to the
 * skill (git-ignored) so it survives across Claude sessions and git pulls.
 */
export const PROFILE_FILE = process.env.DOTACOACH_PROFILE ?? join(import.meta.dir, "..", "profile.json");

export interface Account {
  account_id: number; // Steam32 / Dota friend id
  label?: string; // the user's own name for it, e.g. "main", "smurf"
  persona?: string; // Steam name when last checked
}

export interface Profile {
  main?: Account;
  alts: Account[];
  /** Free-form coaching notes the user wants remembered (preferred roles, goals). */
  notes?: string;
  /** Shared secret Dota's GSI config sends to WatchMatches. */
  gsi_token?: string;
  /** Dota install folder chosen in the dashboard. */
  dota_dir?: string;
  /** Watcher settings saved from the dashboard. */
  watch?: {
    port?: number;
    gsi?: boolean;
    pollMin?: number;
    parse?: boolean;
    review?: boolean;
    waitMin?: number;
    autostart?: boolean;
  };
}

const STEAM64_BASE = 76561197960265728n;

export function loadProfile(): Profile {
  try {
    const p = JSON.parse(readFileSync(PROFILE_FILE, "utf8")) as Partial<Profile>;
    return { ...p, alts: p.alts ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { alts: [] };
    throw new DotaError(`Could not read ${PROFILE_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function saveProfile(p: Profile): void {
  const tmp = `${PROFILE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
  renameSync(tmp, PROFILE_FILE);
}

export function profileAccounts(p: Profile): (Account & { role: "main" | "alt" })[] {
  return [
    ...(p.main ? [{ ...p.main, role: "main" as const }] : []),
    ...p.alts.map((a) => ({ ...a, role: "alt" as const })),
  ];
}

/** Make `acc` the main account. A previous main is kept as an alt. Returns a message. */
export function setMain(p: Profile, acc: Account): string {
  p.alts = p.alts.filter((a) => a.account_id !== acc.account_id);
  let msg = `Main set to ${acc.persona ?? acc.account_id}.`;
  if (p.main && p.main.account_id !== acc.account_id) {
    msg += ` Previous main ${p.main.persona ?? p.main.account_id} kept as an alt.`;
    p.alts.push({ ...p.main, label: p.main.label === "main" ? "old main" : p.main.label });
  }
  p.main = acc;
  return msg;
}

export function addAlt(p: Profile, acc: Account): string {
  if (p.main?.account_id === acc.account_id) throw new DotaError(`${acc.account_id} is already the main account.`);
  p.alts = [...p.alts.filter((a) => a.account_id !== acc.account_id), acc];
  return `Alt ${acc.persona ?? acc.account_id} saved.`;
}

export function removeAccount(p: Profile, id: number): string {
  const before = profileAccounts(p).length;
  if (p.main?.account_id === id) delete p.main;
  p.alts = p.alts.filter((a) => a.account_id !== id);
  if (profileAccounts(p).length === before) throw new DotaError(`${id} is not in the profile.`);
  return `Removed ${id}.`;
}

/** Display name for an account: label, then persona, then id. */
export function accountName(a: Account): string {
  return a.label ?? a.persona ?? String(a.account_id);
}

/**
 * Turn what the user pasted into a Steam32 account id. Accepts the friend id,
 * a Steam64 id, and OpenDota / Dotabuff / STRATZ / Steam profile links.
 */
export function parseAccountId(input: string): number {
  const s = input.trim();
  const fromUrl =
    s.match(/(?:opendota\.com|dotabuff\.com|stratz\.com)\/players\/(\d+)/i)?.[1] ??
    s.match(/steamcommunity\.com\/profiles\/(\d+)/i)?.[1];
  if (/steamcommunity\.com\/id\//i.test(s)) {
    throw new DotaError(
      "Steam custom URLs (steamcommunity.com/id/...) can't be resolved without a Steam API key. " +
        "Use the Friend ID from Dota (Profile > top left), or an opendota.com/players/<id> link.",
    );
  }
  const digits = fromUrl ?? (/^\d+$/.test(s) ? s : null);
  if (!digits) throw new DotaError(`"${input}" is not an account id or profile link.`);
  const n = BigInt(digits);
  const id = n >= STEAM64_BASE ? n - STEAM64_BASE : n;
  if (id <= 0n || id > 0xffffffffn) throw new DotaError(`"${input}" is not a valid Dota account id.`);
  return Number(id);
}

export function steam64ToAccountId(steam64: string): number | null {
  try {
    const n = BigInt(steam64);
    return n > STEAM64_BASE ? Number(n - STEAM64_BASE) : null;
  } catch {
    return null;
  }
}
