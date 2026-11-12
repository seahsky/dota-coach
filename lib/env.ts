import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load <skill dir>/.env into process.env. Bun only auto-loads .env from the
 * current directory, and Claude may run the tools from anywhere. Variables
 * already set in the environment win over the file.
 */
// Only Bun has a skill folder on disk; in the Cloudflare Worker settings come from bindings and secrets.
const IS_BUN = typeof Bun !== "undefined";
export const ENV_FILE = IS_BUN ? join(import.meta.dir, "..", ".env") : "";

function parseFile(): Map<string, string> {
  const vars = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    return vars;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    // Match Bun's dotenv for the common cases: a quoted value may be followed by a comment,
    // and an unquoted value ends at the first #.
    const quoted = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    value = quoted ? quoted[2]! : value.replace(/#.*$/, "").trim();
    vars.set(m[1]!, value);
  }
  return vars;
}

/**
 * Variables set outside the skill's .env (shell, system). Bun also auto-loads
 * ./.env when run from the skill folder, so a variable that is already set
 * with the same value as the file came from the file, not the environment.
 */
const INHERITED = new Map<string, string>();

function load(): void {
  if (!IS_BUN) return;
  const file = parseFile();
  for (const [name, value] of file) {
    const cur = process.env[name];
    if (cur === undefined) process.env[name] = value;
    // A file value with $ is expanded by Bun's loader, so a mismatch there proves nothing.
    else if (cur !== value && !value.includes("$")) INHERITED.set(name, cur);
  }
  for (const name of ["STRATZ_API_KEY", "ANTHROPIC_API_KEY", "DOTACOACH_ON_MATCH"]) {
    const cur = process.env[name];
    if (cur !== undefined && !file.has(name)) INHERITED.set(name, cur);
  }
}

load();

/** True when the shell or system environment sets `name`; that value wins over .env at the next start. */
export const setInEnvironment = (name: string) => Boolean(INHERITED.get(name));

/** True when the value in use right now is the one from the shell or system environment. */
export const fromEnvironment = (name: string) => setInEnvironment(name) && process.env[name] === INHERITED.get(name);

/**
 * Set or remove one variable in <skill dir>/.env, keeping comments and other
 * lines. Also updates process.env so the running process sees the change.
 */
export function setEnvValue(name: string, value: string | null): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name "${name}"`);
  // Bun's own .env loader expands $VAR (even in single quotes) and backslash escapes, so only
  // values it reads back unchanged are allowed: printable ASCII without $ \ quotes, # or backtick.
  if (value !== null && value !== "" && !/^[\x21-\x7e]+$/.test(value.replace(/[$\\'"#`]/g, "\n"))) {
    throw new Error(`${name} can only contain printable characters without spaces, $, \\, quotes, # or backticks.`);
  }
  let lines: string[] = [];
  try {
    lines = readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  } catch {}
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const kept = lines.filter((l) => !re.test(l));
  if (value !== null && value !== "") kept.push(`${name}=${value}`);
  const tmp = `${ENV_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, ENV_FILE);
  // Removing the .env line brings back the shell's value (it wins at the next start anyway).
  if (value === null || value === "") {
    const inherited = INHERITED.get(name);
    if (inherited) process.env[name] = inherited;
    else delete process.env[name];
  } else process.env[name] = value;
}
