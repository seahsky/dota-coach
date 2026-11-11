import { TTL } from "./cache.ts";
import { UnknownHeroError } from "./errors.ts";
import { opendota } from "./http.ts";
import type { OdHero } from "./types.ts";

/**
 * Community nicknames -> internal hero name (npc_dota_hero_<x>). Where a short
 * form is contested, the more common usage wins: "es" Earthshaker (not Ember),
 * "sk" Sand King (not Skeleton King), "vs" Vengeful Spirit (not Void Spirit),
 * "ss" Shadow Shaman, "sd" Shadow Demon.
 */
export const NICKNAMES: Record<string, string> = {
  am: "antimage", magina: "antimage",
  aa: "ancient_apparition",
  aba: "abaddon",
  alch: "alchemist", alche: "alchemist",
  arc: "arc_warden", aw: "arc_warden",
  bat: "batrider",
  bb: "bristleback", bristle: "bristleback",
  bh: "bounty_hunter", gondar: "bounty_hunter",
  bm: "beastmaster", beast: "beastmaster",
  brew: "brewmaster", panda: "brewmaster",
  brood: "broodmother", bs: "bloodseeker", seeker: "bloodseeker",
  cent: "centaur", centaur: "centaur",
  ck: "chaos_knight",
  clock: "rattletrap", cw: "rattletrap", clockwerk: "rattletrap",
  cm: "crystal_maiden", rylai: "crystal_maiden",
  dawn: "dawnbreaker", db: "dawnbreaker",
  dk: "dragon_knight",
  doom: "doom_bringer",
  dp: "death_prophet",
  drow: "drow_ranger", traxex: "drow_ranger",
  ds: "dark_seer",
  dw: "dark_willow",
  ember: "ember_spirit",
  ench: "enchantress",
  es: "earthshaker", shaker: "earthshaker",
  et: "elder_titan",
  earth: "earth_spirit", kaolin: "earth_spirit",
  fv: "faceless_void", void: "faceless_void",
  grim: "grimstroke",
  gyro: "gyrocopter",
  hood: "hoodwink",
  invo: "invoker", invok: "invoker",
  jak: "jakiro",
  jugg: "juggernaut", jug: "juggernaut",
  kotl: "keeper_of_the_light", keeper: "keeper_of_the_light",
  kunk: "kunkka",
  lc: "legion_commander", legion: "legion_commander",
  ld: "lone_druid", druid: "lone_druid",
  lesh: "leshrac",
  ls: "life_stealer", naix: "life_stealer",
  lyc: "lycan",
  mag: "magnataur", magnus: "magnataur",
  medu: "medusa", dusa: "medusa",
  mk: "monkey_king", monkey: "monkey_king",
  morph: "morphling",
  naga: "naga_siren",
  necro: "necrolyte", necrophos: "necrolyte",
  np: "furion", prophet: "furion", furion: "furion",
  ns: "night_stalker", balanar: "night_stalker",
  nyx: "nyx_assassin",
  od: "obsidian_destroyer", outworld: "obsidian_destroyer",
  ogre: "ogre_magi", om: "ogre_magi",
  omni: "omniknight",
  pa: "phantom_assassin", mortred: "phantom_assassin",
  pango: "pangolier",
  pb: "primal_beast",
  pl: "phantom_lancer",
  potm: "mirana", pom: "mirana",
  qop: "queenofpain", queen: "queenofpain",
  rm: "ringmaster",
  rubi: "rubick",
  sb: "spirit_breaker", bara: "spirit_breaker",
  sd: "shadow_demon",
  sf: "nevermore", nevermore: "nevermore",
  sk: "sand_king",
  sky: "skywrath_mage", skywrath: "skywrath_mage",
  slard: "slardar",
  snap: "snapfire",
  spec: "spectre",
  ss: "shadow_shaman", rhasta: "shadow_shaman", shaman: "shadow_shaman",
  storm: "storm_spirit",
  ta: "templar_assassin", lanaya: "templar_assassin",
  tb: "terrorblade",
  tide: "tidehunter",
  timber: "shredder", timbersaw: "shredder",
  tinker: "tinker",
  treant: "treant",
  troll: "troll_warlord",
  ul: "abyssal_underlord", underlord: "abyssal_underlord", pitlord: "abyssal_underlord",
  veno: "venomancer",
  venge: "vengefulspirit", vs: "vengefulspirit",
  voidspirit: "void_spirit",
  wd: "witch_doctor",
  wisp: "wisp", io: "wisp",
  wk: "skeleton_king", skeleton: "skeleton_king", skeletonking: "skeleton_king",
  wl: "warlock", lock: "warlock",
  wr: "windrunner", windrunner: "windrunner", wind: "windrunner",
  ww: "winter_wyvern", wyvern: "winter_wyvern",
  zeus: "zuus", zuus: "zuus",
};

export interface Hero {
  id: number;
  /** Internal name without the npc_dota_hero_ prefix, e.g. "antimage". */
  key: string;
  /** Full internal name, e.g. "npc_dota_hero_antimage". */
  npc: string;
  name: string;
  roles: string[];
  primaryAttr: OdHero["primary_attr"];
  attackType: OdHero["attack_type"];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

let heroesPromise: Promise<Hero[]> | null = null;

export function loadHeroes(): Promise<Hero[]> {
  heroesPromise ??= opendota<Record<string, OdHero>>("/constants/heroes", { ttl: TTL.constants }).then((raw) =>
    Object.values(raw)
      .map((h) => ({
        id: h.id,
        key: h.name.replace("npc_dota_hero_", ""),
        npc: h.name,
        name: h.localized_name,
        roles: h.roles ?? [],
        primaryAttr: h.primary_attr,
        attackType: h.attack_type,
      }))
      .sort((a, b) => a.id - b.id),
  );
  return heroesPromise;
}

export async function heroById(id: number): Promise<Hero | undefined> {
  return (await heroMap()).get(id);
}

let mapPromise: Promise<Map<number, Hero>> | null = null;
export function heroMap(): Promise<Map<number, Hero>> {
  mapPromise ??= loadHeroes().then((hs) => new Map(hs.map((h) => [h.id, h])));
  return mapPromise;
}

/** Display name for a hero id, falling back to "Hero #id" for ids we don't know. */
export async function heroName(id: number): Promise<string> {
  return (await heroById(id))?.name ?? `Hero #${id}`;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Pure resolver over a hero list; exported for tests. */
export function resolveFrom(heroes: Hero[], input: string): Hero {
  const q = norm(input);
  if (!q) throw new UnknownHeroError("No hero name given.");

  if (/^\d+$/.test(q)) {
    const byId = heroes.find((h) => h.id === Number(q));
    if (byId) return byId;
  }

  const byKey = new Map(heroes.map((h) => [norm(h.key), h]));
  const exact =
    heroes.find((h) => norm(h.name) === q) ??
    byKey.get(q) ??
    (NICKNAMES[q] ? byKey.get(norm(NICKNAMES[q]!)) : undefined);
  if (exact) return exact;

  // Initials of the display name: "cm", "ta", "kotl" style inputs not in the table.
  const initials = heroes.filter((h) =>
    norm(h.name.split(/[\s-]+/).filter((w) => !/^(of|the)$/i.test(w)).map((w) => w[0]).join("")) === q && q.length >= 2,
  );
  if (initials.length === 1) return initials[0]!;

  const prefix = heroes.filter((h) => norm(h.name).startsWith(q) || norm(h.key).startsWith(q));
  const wordPrefix = heroes.filter((h) => h.name.toLowerCase().split(/[\s-]+/).some((w) => norm(w).startsWith(q)));
  // "spirit" prefixes only Spirit Breaker's full name but is a word in five other names.
  if (prefix.length === 1 && wordPrefix.length <= 1) return prefix[0]!;
  if (prefix.length === 0 && wordPrefix.length === 1) return wordPrefix[0]!;

  const ambiguous = prefix.length > 1 ? prefix : wordPrefix.length > 1 ? [...new Set([...prefix, ...wordPrefix])] : [];
  if (ambiguous.length > 1) {
    throw new UnknownHeroError(
      `"${input}" matches several heroes: ${ambiguous.map((h) => h.name).join(", ")}. Be more specific.`,
    );
  }

  const scored = heroes
    .map((h) => ({ h, d: Math.min(levenshtein(q, norm(h.name)), levenshtein(q, norm(h.key))) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0]!;
  const maxDist = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
  if (best.d <= maxDist && scored[1]!.d > best.d) return best.h;

  const suggestions = scored.slice(0, 3).map((s) => s.h.name).join(", ");
  throw new UnknownHeroError(`Unknown hero "${input}". Closest matches: ${suggestions}.`);
}

export async function resolveHero(input: string): Promise<Hero> {
  return resolveFrom(await loadHeroes(), input);
}
