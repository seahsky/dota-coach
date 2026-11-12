import { describe, expect, test } from "bun:test";
import { parseCli } from "../lib/cli.ts";
import { CliHelp, DotaError } from "../lib/errors.ts";

const known = { strings: ["top", "vs"], booleans: ["draft"] };

describe("parseCli", () => {
  test("positionals, --key=value, --key value and booleans", () => {
    const a = parseCli("u", known, ["anti", "mage", "--top=5", "--vs", "pudge", "--draft", "--json"]);
    expect(a.positionals).toEqual(["anti", "mage"]);
    expect(a.flags).toEqual({ top: "5", vs: "pudge", draft: true, json: true });
    expect(a.json).toBe(true);
  });
  test("unknown and malformed options are errors", () => {
    expect(() => parseCli("u", known, ["--nope"])).toThrow(DotaError);
    expect(() => parseCli("u", known, ["-x"])).toThrow(DotaError);
    expect(() => parseCli("u", known, ["--draft=1"])).toThrow(DotaError);
    expect(() => parseCli("u", known, ["--top"])).toThrow(DotaError);
  });
  test("--help and --", () => {
    expect(() => parseCli("u", known, ["--help"])).toThrow(CliHelp);
    expect(parseCli("u", known, ["--", "--top"]).positionals).toEqual(["--top"]);
  });
});
