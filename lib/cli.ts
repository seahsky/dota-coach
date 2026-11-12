import { CliHelp, DotaError } from "./errors.ts";

export interface ParsedArgs {
  flags: Record<string, string | boolean | undefined>;
  positionals: string[];
  json: boolean;
}

/**
 * Parse `--key=value`, `--key value` and `--flag` style arguments. `known`
 * lists the value-taking options; anything else starting with `--` is an
 * error so typos don't silently do nothing.
 */
export function parseCli(
  usage: string,
  known: { strings?: string[]; booleans?: string[] } = {},
  argv: string[] = Bun.argv.slice(2),
): ParsedArgs {
  const options: Record<string, { type: "string" | "boolean" }> = { json: { type: "boolean" }, help: { type: "boolean" } };
  for (const s of known.strings ?? []) options[s] = { type: "string" };
  for (const b of known.booleans ?? []) options[b] = { type: "boolean" };
  let parsed;
  try {
    parsed = parseArgv(argv, options);
  } catch (err) {
    throw new DotaError(`${err instanceof Error ? err.message : String(err)}\nUsage: ${usage}`);
  }
  if (parsed.flags.help) throw new CliHelp(`Usage: ${usage}`);
  return { ...parsed, json: Boolean(parsed.flags.json) };
}

/**
 * The subset of node:util parseArgs the tools use (long options only, strict), written out
 * because the Cloudflare Workers runtime does not implement parseArgs.
 */
function parseArgv(
  argv: string[],
  options: Record<string, { type: "string" | "boolean" }>,
): { flags: ParsedArgs["flags"]; positionals: string[] } {
  const flags: ParsedArgs["flags"] = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (/^-[A-Za-z]/.test(arg)) throw new Error(`Unknown option '${arg}'`);
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const opt = options[name];
    if (!opt) throw new Error(`Unknown option '--${name}'`);
    if (opt.type === "boolean") {
      if (eq >= 0) throw new Error(`Option '--${name}' does not take an argument`);
      flags[name] = true;
    } else if (eq >= 0) {
      flags[name] = arg.slice(eq + 1);
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Option '--${name} <value>' argument missing`);
      flags[name] = value;
      i++;
    }
  }
  return { flags, positionals };
}

export function intFlag(value: unknown, name: string, fallback: number, min = 1, max = 1000): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new DotaError(`--${name} must be a whole number between ${min} and ${max} (got "${value}").`);
  }
  return n;
}

/** Either the markdown rendering or the JSON payload, ending in a newline. */
export function output(args: ParsedArgs, data: unknown, markdown: () => string): string {
  return args.json ? JSON.stringify(data, null, 2) + "\n" : markdown().trimEnd() + "\n";
}

export function table(headers: string[], rows: (string | number)[][], align?: ("l" | "r")[]): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const sep = headers.map((_, i) => ((align?.[i] ?? "l") === "r" ? "--:" : "---"));
  return [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
export const signedPct = (x: number, digits = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
export const num = (x: number) => x.toLocaleString("en-US");

export function duration(sec: number): string {
  if (sec < 0) return `-${duration(-sec)}`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function sourceLine(source: string, extra?: string): string {
  return `_Source: ${source}${extra ? ` · ${extra}` : ""}_`;
}

/** Strip the small amount of HTML Valve embeds in text fields. */
export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
