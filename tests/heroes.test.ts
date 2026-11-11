import { describe, expect, test } from "bun:test";
import { loadHeroes, NICKNAMES, resolveFrom } from "../lib/heroes.ts";

const heroes = await loadHeroes();
const name = (q: string) => resolveFrom(heroes, q).name;

describe("hero resolver", () => {
  test.each([
    ["am", "Anti-Mage"],
    ["antimage", "Anti-Mage"],
    ["Anti-Mage", "Anti-Mage"],
    ["wr", "Windranger"],
    ["es", "Earthshaker"],
    ["qop", "Queen of Pain"],
    ["pudge", "Pudge"],
    ["sf", "Shadow Fiend"],
    ["np", "Nature's Prophet"],
    ["natures prophet", "Nature's Prophet"],
    ["kotl", "Keeper of the Light"],
    ["jugernaut", "Juggernaut"],
    ["14", "Pudge"],
  ])("%s -> %s", (q, expected) => expect(name(q)).toBe(expected));

  test("ambiguous input lists candidates", () => {
    expect(() => name("shadow")).toThrow(/Shadow Fiend, Shadow Shaman, Shadow Demon/);
  });

  test("unknown input suggests close matches", () => {
    expect(() => name("xyzzy")).toThrow(/Unknown hero "xyzzy"/);
  });

  test("every nickname points at a real hero", () => {
    const keys = new Set(heroes.map((h) => h.key));
    const broken = Object.entries(NICKNAMES).filter(([, k]) => !keys.has(k));
    expect(broken).toEqual([]);
  });
});
