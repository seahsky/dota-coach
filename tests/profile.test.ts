import { expect, test } from "bun:test";
import { parseAccountId, steam64ToAccountId } from "../lib/profile.ts";

test("parseAccountId accepts friend ids, Steam64 ids and profile links", () => {
  expect(parseAccountId("86745912")).toBe(86745912);
  expect(parseAccountId("76561198047011640")).toBe(86745912);
  expect(parseAccountId("https://www.opendota.com/players/86745912/matches")).toBe(86745912);
  expect(parseAccountId("https://www.dotabuff.com/players/86745912")).toBe(86745912);
  expect(parseAccountId("stratz.com/players/86745912")).toBe(86745912);
  expect(parseAccountId("https://steamcommunity.com/profiles/76561198047011640/")).toBe(86745912);
});

test("parseAccountId rejects vanity URLs and junk", () => {
  expect(() => parseAccountId("https://steamcommunity.com/id/someone")).toThrow(/custom URLs/);
  expect(() => parseAccountId("bob")).toThrow();
  expect(() => parseAccountId("0")).toThrow();
});

test("steam64ToAccountId", () => {
  expect(steam64ToAccountId("76561198047011640")).toBe(86745912);
  expect(steam64ToAccountId("x")).toBeNull();
});
