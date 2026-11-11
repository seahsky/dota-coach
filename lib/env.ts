import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load <skill dir>/.env into process.env. Bun only auto-loads .env from the
 * current directory, and Claude may run the tools from anywhere. Variables
 * already set in the environment win over the file.
 */
export const ENV_FILE = join(import.meta.dir, "..", ".env");

function load(): void {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    const quoted = value.match(/^(["'])(.*)\1$/);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

load();

/**
 * Set or remove one variable in <skill dir>/.env, keeping comments and other
 * lines. Also updates process.env so the running process sees the change.
 */
export function setEnvValue(name: string, value: string | null): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name "${name}"`);
  if (value !== null && /[\r\n]/.test(value)) throw new Error(`${name} cannot contain line breaks`);
  let lines: string[] = [];
  try {
    lines = readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  } catch {}
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const kept = lines.filter((l) => !re.test(l));
  if (value !== null && value !== "") {
    // Quote so a trailing " #..." is not read back as a comment. The loader does no escaping.
    let out = value;
    if (/[\s#"'$]/.test(value)) {
      if (!value.includes("'")) out = `'${value}'`;
      else if (!value.includes('"')) out = `"${value}"`;
      else throw new Error(`${name} cannot contain both ' and " quotes`);
    }
    kept.push(`${name}=${out}`);
  }
  const tmp = `${ENV_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, ENV_FILE);
  if (value === null || value === "") delete process.env[name];
  else process.env[name] = value;
}
