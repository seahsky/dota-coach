import { parseArgs } from "node:util";
import { DotaError } from "./errors.ts";

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
): ParsedArgs {
  const options: Record<string, { type: "string" | "boolean" }> = { json: { type: "boolean" }, help: { type: "boolean" } };
  for (const s of known.strings ?? []) options[s] = { type: "string" };
  for (const b of known.booleans ?? []) options[b] = { type: "boolean" };
  let parsed;
  try {
    parsed = parseArgs({ args: Bun.argv.slice(2), options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new DotaError(`${err instanceof Error ? err.message : String(err)}\nUsage: ${usage}`);
  }
  if (parsed.values.help) {
    process.stdout.write(`Usage: ${usage}\n`);
    process.exit(0);
  }
  return {
    flags: parsed.values as ParsedArgs["flags"],
    positionals: parsed.positionals,
    json: Boolean(parsed.values.json),
  };
}

export function intFlag(value: unknown, name: string, fallback: number, min = 1, max = 1000): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new DotaError(`--${name} must be a whole number between ${min} and ${max} (got "${value}").`);
  }
  return n;
}

/** Print either the markdown rendering or the JSON payload. */
export function output(args: ParsedArgs, data: unknown, markdown: () => string): void {
  process.stdout.write(args.json ? JSON.stringify(data, null, 2) + "\n" : markdown().trimEnd() + "\n");
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
