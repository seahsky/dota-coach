/** An error whose message is safe and useful to show the user as-is. */
export class DotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DotaError";
  }
}

export class RateLimitError extends DotaError {}
/** --help: main() prints the message and exits 0. */
export class CliHelp extends DotaError {}
export class NotFoundError extends DotaError {}
export class UnknownHeroError extends DotaError {}

/**
 * Entry point wrapper for every tool. Prints what the tool returns; on failure prints a
 * one-line error to stderr and exits 1 instead of letting Bun print a stack trace.
 */
export async function main(fn: () => Promise<void | string>): Promise<void> {
  try {
    const out = await fn();
    if (typeof out === "string") process.stdout.write(out);
  } catch (err) {
    if (err instanceof CliHelp) {
      process.stdout.write(`${err.message}\n`);
      process.exit(0);
    }
    const msg = err instanceof DotaError
      ? err.message
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`Error: ${msg}\n`);
    if (process.env.DOTACOACH_DEBUG && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  }
}
