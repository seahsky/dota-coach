import { readFileSync } from "node:fs";
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
