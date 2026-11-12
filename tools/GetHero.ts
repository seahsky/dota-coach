import { TTL } from "../lib/cache.ts";
import { output, parseCli, sourceLine, stripHtml } from "../lib/cli.ts";
import { DotaError, NotFoundError, main } from "../lib/errors.ts";
import { resolveHero, type Hero } from "../lib/heroes.ts";
import { opendota, valve } from "../lib/http.ts";
import type {
  OdHeroAbilities,
  ValveAbility,
  ValveAbilityList,
  ValveHeroData,
  ValveSpecialValue,
} from "../lib/types.ts";

const USAGE = 'bun run tools/GetHero.ts "<hero>" [--json]';

// lib/types.ts omits these fields; they are present in every live herodata/abilitydata response.
interface Bonus {
  name: string;
  value: number;
  operation: number;
}
type SpecialValue = ValveSpecialValue & { bonuses?: Bonus[] };
type Ability = Omit<ValveAbility, "special_values"> & { special_values: SpecialValue[]; lore_loc?: string };
type HeroData = Omit<ValveHeroData, "abilities" | "talents"> & { abilities: Ability[]; talents: Ability[] };

// Index -> role. Checked against OpenDota /constants/heroes roles for all 127
// heroes on 2026-11-11 (nonzero level <=> role listed, 127/127 per index).
// Index 4 is zero for every hero and has no OpenDota counterpart.
const ROLE_INDEX: (string | null)[] = ["Carry", "Support", "Nuker", "Disabler", null, "Durable", "Escape", "Pusher", "Initiator"];
const ATTR = ["Strength", "Agility", "Intelligence", "Universal"];
// Verified against OpenDota dmg_type / bkbpierce for every hero ability.
const DAMAGE_TYPE: Record<number, string> = { 1: "Physical", 2: "Magical", 4: "Pure" };
const PIERCES: Record<number, boolean> = { 1: true, 3: true, 2: false, 4: false };
const BEHAVIOR_PASSIVE = 2n;
const BEHAVIOR_TOGGLE = 512n;

// Template names that refer to the ability's own base fields rather than a special value.
const FIELD_VARS: Record<string, keyof Ability> = {
  abilityduration: "durations",
  abilitychanneltime: "channel_times",
  abilitycastpoint: "cast_points",
  abilitycastrange: "cast_ranges",
  abilitycooldown: "cooldowns",
  abilitymanacost: "mana_costs",
};

// ---------- Formatting helpers ----------

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(2))));

function levels(arr: number[] | undefined): string {
  if (!arr?.length) return "";
  return arr.every((v) => v === arr[0]) ? fmt(arr[0]!) : arr.map(fmt).join("/");
}

const nonZero = (arr: number[] | undefined) => Boolean(arr?.some((v) => v !== 0));

const SMALL = new Set(["per", "of", "the", "to", "a", "and", "from", "in", "on", "for", "at", "as", "with", "vs"]);
const UPPER = new Set(["hp", "dps", "aoe", "bat"]);

function label(heading: string): string {
  const s = stripHtml(heading).replace(/:\s*$/, "").toLowerCase();
  return s
    .split(" ")
    .map((w, i) => {
      const bare = w.replace(/[^a-z]/g, "");
      if (UPPER.has(bare)) return w.toUpperCase();
      if (i > 0 && SMALL.has(bare)) return w;
      return w.replace(/[a-z]/, (c) => c.toUpperCase());
    })
    .join(" ");
}

// ---------- Template substitution ----------

type Mode = "base" | "scepter" | "shard";

/**
 * Valve text uses "%name%" (ability text) and "{s:name}" (talents) for values,
 * and "%%" for a literal percent sign. Names are matched case-insensitively
 * because text says "%abilityduration%" while the value is "AbilityDuration".
 * Unresolvable names render as "?" (about 20 of ~900 references on 2026-11-11,
 * all in Scepter/Shard text whose values Valve does not ship).
 */
function renderAbilityText(text: string, ab: Ability, mode: Mode): string {
  const byName = new Map(ab.special_values.map((s) => [s.name.toLowerCase(), s]));
  const upgraded = (s: SpecialValue | undefined) =>
    mode === "scepter" ? s?.values_scepter : mode === "shard" ? s?.values_shard : undefined;
  const lookup = (raw: string): string => {
    const name = raw.toLowerCase();
    const own = byName.get(name);
    if (own) {
      const up = upgraded(own);
      if (!up?.length) return levels(own.values_float) || "?";
      // Upgrade values are adjustments whose operation Valve does not expose
      // (Pudge Rot radius 250 with Scepter 200 is +200; Underlord's Scepter
      // cooldown 20 is a reduction). The upgraded total is only known when the
      // base is zero.
      return nonZero(own.values_float) ? "?" : levels(up);
    }
    // Upgrade text phrases the increase as "bonus_<value>"; it is the value's scepter/shard entry.
    if (name.startsWith("bonus_")) {
      const up = upgraded(byName.get(name.slice(6)));
      if (up?.length) return levels(up);
    }
    const field = FIELD_VARS[name];
    if (field) {
      const arr = ab[field] as number[];
      if (nonZero(arr)) return levels(arr);
    }
    return "?";
  };
  const out = text
    .replace(/%([A-Za-z0-9_]*)%/g, (_, n: string) => (n === "" ? "%" : lookup(n)))
    .replace(/\{s:([A-Za-z0-9_]+)\}/g, (_, n: string) => lookup(n));
  return stripHtml(out);
}

/**
 * Talent text "{s:value}" reads the talent's own special values; "{s:bonus_X}"
 * reads the bonus this talent adds to special value X of one of the hero's
 * abilities (e.g. special_bonus_unique_antimage_5 adds 9 to Persecutor's
 * move_slow_min). The sign is part of the template ("+{s:..}", "-{s:..}"), so
 * the magnitude is used to avoid "+-10%".
 */
function talentBonuses(talent: Ability, abilities: Ability[]): { target: string; value: number }[] {
  const out: { target: string; value: number }[] = [];
  for (const ab of abilities) {
    for (const sv of ab.special_values) {
      const b = sv.bonuses?.find((x) => x.name === talent.name);
      if (b) out.push({ target: sv.name.toLowerCase(), value: b.value });
    }
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{s:([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!.toLowerCase());

/** True when a "{s:bonus_X}" in the talent name has no matching bonus in `abilities`. */
function talentNeedsMore(talent: Ability, abilities: Ability[]): boolean {
  const own = new Set(talent.special_values.map((s) => s.name.toLowerCase()));
  const bonuses = talentBonuses(talent, abilities);
  return placeholders(talent.name_loc).some(
    (n) => !own.has(n) && n.startsWith("bonus_") && !bonuses.some((b) => b.target === n.slice(6)),
  );
}

function renderTalent(text: string, talent: Ability, abilities: Ability[]): string {
  const own = new Map(talent.special_values.map((s) => [s.name.toLowerCase(), s]));
  const bonuses = talentBonuses(talent, abilities);
  const slots = placeholders(text);
  const lookup = (raw: string): string => {
    const name = raw.toLowerCase();
    const o = own.get(name);
    if (o?.values_float.length) return levels(o.values_float.map(Math.abs));
    if (name.startsWith("bonus_")) {
      const b = bonuses.find((x) => x.target === name.slice(6));
      if (b) return fmt(Math.abs(b.value));
      // Some templates name a variable that no longer exists while the talent's
      // only bonus sits on a renamed one (Invoker's Forged Spirit armor talent
      // says bonus_armor_removed; the bonus is on armor_per_attack).
      if (bonuses.length === 1 && slots.length === 1) return fmt(Math.abs(bonuses[0]!.value));
    }
    return "?";
  };
  return stripHtml(
    text.replace(/\{s:([A-Za-z0-9_]+)\}/g, (_, n: string) => lookup(n)).replace(/%([A-Za-z0-9_]*)%/g, (_, n: string) => (n === "" ? "%" : lookup(n))),
  );
}

// ---------- Model ----------

interface KeyValue {
  key: string;
  label: string;
  value: string;
  percent: boolean;
  /**
   * Valve's values_scepter / values_shard. When `value` is non-empty these are
   * adjustments to it whose sign/operation Valve does not expose; when the base
   * is zero they are the upgraded value.
   */
  scepter?: string;
  shard?: string;
}

interface AbilityOut {
  id: number;
  key: string;
  name: string;
  ultimate: boolean;
  innate: boolean;
  passive: boolean;
  toggle: boolean;
  grantedByScepter: boolean;
  grantedByShard: boolean;
  maxLevel: number;
  cooldown: string | null;
  manaCost: string | null;
  castRange: string | null;
  damageType: string | null;
  piercesDebuffImmunity: boolean | null;
  description: string;
  values: KeyValue[];
  scepter: string | null;
  shard: string | null;
  notes: string[];
}

interface TalentOut {
  level: number;
  key: string;
  name: string;
  description?: string;
  /** OpenDota's level for this talent when it disagrees with Valve's ordering, or null if OpenDota lacks it. */
  opendotaLevel?: number | null;
}

interface Result {
  source: string;
  hero: {
    id: number;
    key: string;
    name: string;
    primaryAttribute: string;
    attackType: string;
    complexity: number;
    summary: string;
  };
  roles: { role: string; level: number | null }[];
  rolesSource: string;
  stats: {
    strength: { base: number; gain: number };
    agility: { base: number; gain: number };
    intelligence: { base: number; gain: number };
    health: number;
    healthRegen: number;
    mana: number;
    manaRegen: number;
    damageMin: number;
    damageMax: number;
    armor: number;
    magicResistance: number;
    attackRange: number;
    projectileSpeed: number;
    baseAttackTime: number;
    moveSpeed: number;
    turnRate: number;
    visionDay: number;
    visionNight: number;
  };
  abilities: AbilityOut[];
  talents: TalentOut[];
  talentCheck: string;
  facets: { count: number; note: string };
  spiritBear?: AbilityOut[];
  notes: string[];
}

function isHiddenAbility(a: Ability): boolean {
  return !a.name_loc || a.name.startsWith("generic_hidden") || /(^|_)empty\d*$/.test(a.name);
}

function behavior(a: Ability): bigint {
  try {
    return BigInt(a.behavior);
  } catch {
    return 0n;
  }
}

/**
 * Valve's is_percentage misses a few "_pct" values (Anti-Mage max mana burned
 * 1.8 is 1.8% of max mana; Zeus Static Field 3.45 is % of current health).
 * On 2026-11-11 all 14 such headed values were percentages except attack-speed
 * ones, which are flat attack speed, hence the heading exclusion.
 */
function isPercent(sv: SpecialValue): boolean {
  if (sv.is_percentage) return true;
  return /pct|percent/i.test(sv.name) && !/attack (speed|slow)|attack speed/i.test(stripHtml(sv.heading_loc));
}

function toAbility(a: Ability): AbilityOut {
  const b = behavior(a);
  const values: KeyValue[] = [];
  for (const sv of a.special_values) {
    // AbilityCooldown etc. repeat the CD/mana/range already shown from the base fields.
    if (!sv.heading_loc || /^ability/i.test(sv.name)) continue;
    const base = nonZero(sv.values_float) ? levels(sv.values_float) : "";
    const scepter = nonZero(sv.values_scepter) ? levels(sv.values_scepter) : undefined;
    const shard = nonZero(sv.values_shard) ? levels(sv.values_shard) : undefined;
    if (!base && !scepter && !shard) continue;
    values.push({ key: sv.name, label: label(sv.heading_loc), value: base, percent: isPercent(sv), scepter, shard });
  }
  return {
    id: a.id,
    key: a.name,
    name: a.name_loc,
    ultimate: a.type === 1,
    innate: a.ability_is_innate,
    passive: (b & BEHAVIOR_PASSIVE) !== 0n,
    toggle: (b & BEHAVIOR_TOGGLE) !== 0n,
    grantedByScepter: a.ability_is_granted_by_scepter,
    grantedByShard: a.ability_is_granted_by_shard,
    maxLevel: a.max_level,
    cooldown: nonZero(a.cooldowns) ? levels(a.cooldowns) : null,
    manaCost: nonZero(a.mana_costs) ? levels(a.mana_costs) : null,
    castRange: nonZero(a.cast_ranges) ? levels(a.cast_ranges) : null,
    damageType: DAMAGE_TYPE[a.damage] ?? null,
    piercesDebuffImmunity: PIERCES[a.immunity] ?? null,
    description: renderAbilityText(a.desc_loc, a, "base"),
    values,
    scepter: a.scepter_loc ? renderAbilityText(a.scepter_loc, a, "scepter") : null,
    shard: a.shard_loc ? renderAbilityText(a.shard_loc, a, "shard") : null,
    notes: (a.notes_loc ?? []).filter(Boolean).map((n) => renderAbilityText(n, a, "base")),
  };
}

// ---------- Data ----------

async function fetchHeroData(id: number, name: string): Promise<HeroData> {
  const res = await valve<{ result?: { data?: { heroes?: HeroData[] } } }>(`/herodata?language=english&hero_id=${id}`, {
    ttl: TTL.patch,
    what: `Hero data for ${name}`,
  });
  const h = res?.result?.data?.heroes?.[0];
  if (!h) throw new NotFoundError(`Valve datafeed has no hero data for ${name} (id ${id}).`);
  return h;
}

/**
 * Spirit Bear's own abilities are not in Lone Druid's herodata. Summon Spirit
 * Bear's description names them ("Spirit Bear has Demolish, Return, ...
 * abilities."), and the abilitylist also carries retired bear abilities (e.g.
 * Fetch), so the description decides which ones to show.
 */
async function fetchSpiritBear(summon: Ability): Promise<AbilityOut[] | { error: string }> {
  const m = stripHtml(summon.desc_loc).match(/Spirit Bear has (.+?) abilities/);
  if (!m) return { error: "Summon Spirit Bear's description no longer lists the bear's abilities." };
  const wanted = m[1]!.split(/,\s*(?:and\s+)?|\s+and\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const list = await valve<ValveAbilityList>("/abilitylist?language=english", { ttl: TTL.constants });
  const candidates = list.result.data.itemabilities.filter(
    (a) => (a.name.startsWith("lone_druid_spirit_bear_") || a.name.endsWith("_bear")) && a.name.startsWith("lone_druid") && a.name_loc,
  );
  const picked = wanted
    .map((w) => candidates.find((c) => c.name_loc.toLowerCase() === w))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  const data = await Promise.all(
    picked.map((c) =>
      valve<{ result?: { data?: { abilities?: Ability[] } } }>(`/abilitydata?language=english&ability_id=${c.id}`, {
        ttl: TTL.patch,
        what: `Ability ${c.name}`,
      }),
    ),
  );
  return data.map((d) => d.result?.data?.abilities?.[0]).filter((a): a is Ability => Boolean(a)).map(toAbility);
}

/**
 * Some talents modify an ability that herodata leaves out (Tinker's Keen
 * Conveyance, Naga Siren's Reel In), so the bonus value is only in that
 * ability's /abilitydata. Find it by the ability name the talent text mentions.
 */
async function fetchTalentSubAbilities(h: HeroData, talents: Ability[]): Promise<Ability[]> {
  const prefix = h.name.replace(/^npc_dota_hero_/, "") + "_";
  const known = new Set(h.abilities.map((a) => a.name));
  const list = await valve<ValveAbilityList>("/abilitylist?language=english", { ttl: TTL.constants });
  const picked = list.result.data.itemabilities.filter(
    (a) =>
      a.name.startsWith(prefix) &&
      !a.name.startsWith("special_bonus") &&
      !known.has(a.name) &&
      a.name_loc &&
      talents.some((t) => stripHtml(t.name_loc).toLowerCase().includes(a.name_loc.toLowerCase())),
  );
  const data = await Promise.all(
    picked.slice(0, 4).map((c) =>
      valve<{ result?: { data?: { abilities?: Ability[] } } }>(`/abilitydata?language=english&ability_id=${c.id}`, {
        ttl: TTL.patch,
        what: `Ability ${c.name}`,
      }),
    ),
  );
  return data.map((d) => d.result?.data?.abilities?.[0]).filter((a): a is Ability => Boolean(a));
}

async function build(hero: Hero): Promise<Result> {
  const h = await fetchHeroData(hero.id, hero.name);
  const notes: string[] = [];

  const valveRoles = ROLE_INDEX.flatMap((role, i) => {
    const lv = h.role_levels?.[i] ?? 0;
    return role && lv > 0 ? [{ role, level: lv }] : [];
  }).sort((a, b) => b.level - a.level);
  const sameRoles =
    valveRoles.length === hero.roles.length && valveRoles.every((r) => hero.roles.includes(r.role));
  const roles = sameRoles ? valveRoles : hero.roles.map((role) => ({ role, level: null }));
  const rolesSource = sameRoles ? "Valve role_levels (matches OpenDota roles)" : "OpenDota /constants/heroes (Valve role_levels disagreed)";

  const abilities = h.abilities.filter((a) => !isHiddenAbility(a)).map(toAbility);

  let talentAbilities: Ability[] = h.abilities;
  const needMore = h.talents.filter((t) => talentNeedsMore(t, h.abilities));
  if (needMore.length) {
    try {
      talentAbilities = [...h.abilities, ...(await fetchTalentSubAbilities(h, needMore))];
    } catch {
      // Best effort: the talent then renders "?" for that value.
    }
  }
  const talents: TalentOut[] = h.talents.map((t, i) => {
    const description = t.desc_loc ? renderTalent(t.desc_loc, t, talentAbilities) : undefined;
    return {
      level: 10 + 5 * Math.floor(i / 2),
      key: t.name,
      name: renderTalent(t.name_loc, t, talentAbilities),
      ...(description ? { description } : {}),
    };
  });

  let talentCheck: string;
  try {
    const od = await opendota<Record<string, OdHeroAbilities>>("/constants/hero_abilities", { ttl: TTL.constants });
    const odTalents = od[h.name]?.talents;
    if (!odTalents) {
      talentCheck = "OpenDota has no talent data for this hero; levels follow Valve's order.";
    } else {
      const odLevel = new Map(odTalents.map((t) => [t.name, 10 + 5 * (t.level - 1)]));
      let diff = 0;
      for (const t of talents) {
        const l = odLevel.get(t.key);
        if (l !== t.level) {
          t.opendotaLevel = l ?? null;
          diff++;
        }
      }
      talentCheck = diff
        ? `OpenDota's hero_abilities constants disagree on ${diff} of ${talents.length} talents (missing or at another level); Valve's current data is used.`
        : "Talent levels match OpenDota's hero_abilities constants.";
    }
  } catch (err) {
    talentCheck = `OpenDota cross-check skipped: ${err instanceof Error ? err.message : String(err)}`;
  }

  const facetCount = h.facets?.length ?? 0;
  const facets = {
    count: facetCount,
    note: facetCount
      ? `Valve lists ${facetCount} facets for this hero.`
      : 'None. Valve\'s hero data lists no facets; patch 7.41 notes say "Facets removed from the game".',
  };

  let spiritBear: AbilityOut[] | undefined;
  const summon = h.abilities.find((a) => a.name === "lone_druid_spirit_bear");
  if (summon) {
    try {
      const bear = await fetchSpiritBear(summon);
      if (Array.isArray(bear)) spiritBear = bear;
      else notes.push(`Spirit Bear abilities not shown: ${bear.error}`);
    } catch (err) {
      notes.push(`Spirit Bear abilities not shown: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    source: "Valve datafeed /herodata (live values); roles and talent-level check against OpenDota /constants",
    hero: {
      id: h.id,
      key: h.name,
      name: h.name_loc,
      primaryAttribute: ATTR[h.primary_attr] ?? `attr ${h.primary_attr}`,
      attackType: h.attack_capability === 2 ? "Ranged" : h.attack_capability === 1 ? "Melee" : hero.attackType,
      complexity: h.complexity,
      summary: stripHtml(h.npe_desc_loc ?? ""),
    },
    roles,
    rolesSource,
    stats: {
      strength: { base: h.str_base, gain: h.str_gain },
      agility: { base: h.agi_base, gain: h.agi_gain },
      intelligence: { base: h.int_base, gain: h.int_gain },
      health: h.max_health,
      healthRegen: Number(h.health_regen.toFixed(2)),
      mana: h.max_mana,
      manaRegen: Number(h.mana_regen.toFixed(2)),
      damageMin: h.damage_min,
      damageMax: h.damage_max,
      armor: Number(h.armor.toFixed(2)),
      magicResistance: h.magic_resistance,
      attackRange: h.attack_range,
      projectileSpeed: h.projectile_speed,
      baseAttackTime: h.attack_rate,
      moveSpeed: h.movement_speed,
      turnRate: h.turn_rate,
      visionDay: h.sight_range_day,
      visionNight: h.sight_range_night,
    },
    abilities,
    talents,
    talentCheck,
    facets,
    ...(spiritBear ? { spiritBear } : {}),
    notes,
  };
}

// ---------- Markdown ----------

function tags(a: AbilityOut): string[] {
  const t: string[] = [];
  if (a.innate) t.push("Innate");
  if (a.ultimate) t.push("Ultimate");
  if (a.grantedByScepter) t.push("Scepter-granted");
  if (a.grantedByShard) t.push("Shard-granted");
  if (a.passive) t.push("Passive");
  if (a.toggle) t.push("Toggle");
  return t;
}

function abilityBlock(a: AbilityOut, heading = "###"): string[] {
  const t = tags(a);
  const lines = [`${heading} ${a.name}${t.length ? ` (${t.join(", ")})` : ""}`];
  const facts = [
    a.cooldown && `CD ${a.cooldown}s`,
    a.manaCost && `Mana ${a.manaCost}`,
    a.castRange && `Range ${a.castRange}`,
    a.damageType,
    a.piercesDebuffImmunity !== null && `Pierces debuff immunity: ${a.piercesDebuffImmunity ? "yes" : "no"}`,
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(" · "));
  if (a.description) lines.push(a.description);
  if (a.values.length) {
    const vals = a.values.map((v) => {
      const pc = v.percent ? "%" : "";
      const base = v.value ? `${v.value}${pc}` : "";
      const word = base ? " change" : "";
      const up = [v.scepter && `Scepter${word} ${v.scepter}${pc}`, v.shard && `Shard${word} ${v.shard}${pc}`].filter(Boolean).join(", ");
      return `${v.label}: ${base}${base && up ? ` (${up})` : up}`;
    });
    lines.push(`Values: ${vals.join(" · ")}`);
  }
  return lines;
}

function upgradeLines(abilities: AbilityOut[], kind: "scepter" | "shard"): string[] {
  const out: string[] = [];
  for (const a of abilities) {
    const granted = kind === "scepter" ? a.grantedByScepter : a.grantedByShard;
    const text = a[kind];
    if (text) out.push(`- ${a.name}: ${text}`);
    else if (granted) out.push(`- Grants ${a.name}: ${a.description}`);
  }
  return out;
}

function markdown(r: Result): string {
  const s = r.stats;
  const roleText = r.roles.length
    ? r.roles.map((x) => (x.level !== null ? `${x.role} ${x.level}` : x.role)).join(", ")
    : "none listed";
  const L: string[] = [
    `# ${r.hero.name}`,
    `${r.hero.primaryAttribute} · ${r.hero.attackType} · Complexity ${r.hero.complexity}/3${r.hero.summary ? ` · ${r.hero.summary}` : ""}`,
    `Roles${r.roles[0]?.level != null ? " (Valve level 1-3)" : ""}: ${roleText}`,
    "",
    "## Base stats (level 1, as Valve reports them)",
    `- Str ${fmt(s.strength.base)} +${fmt(s.strength.gain)} · Agi ${fmt(s.agility.base)} +${fmt(s.agility.gain)} · Int ${fmt(s.intelligence.base)} +${fmt(s.intelligence.gain)}`,
    `- HP ${s.health} (regen ${fmt(s.healthRegen)}) · Mana ${s.mana} (regen ${fmt(s.manaRegen)})`,
    `- Damage ${s.damageMin}-${s.damageMax} · BAT ${fmt(s.baseAttackTime)} · Attack range ${s.attackRange}${r.hero.attackType === "Ranged" && s.projectileSpeed ? ` · Projectile speed ${s.projectileSpeed}` : ""}`,
    `- Armor ${fmt(s.armor)} · Magic resistance ${fmt(s.magicResistance)}% · Move speed ${s.moveSpeed} · Turn rate ${fmt(s.turnRate)} · Vision ${s.visionDay}/${s.visionNight} (day/night)`,
    "",
    "## Abilities",
  ];
  for (const a of r.abilities) L.push(...abilityBlock(a), "");

  const scepter = upgradeLines(r.abilities, "scepter");
  const shard = upgradeLines(r.abilities, "shard");
  L.push("## Aghanim's Scepter", ...(scepter.length ? scepter : ["- No Scepter upgrade listed by Valve."]), "");
  L.push("## Aghanim's Shard", ...(shard.length ? shard : ["- No Shard upgrade listed by Valve."]), "");

  if (r.spiritBear?.length) {
    L.push("## Spirit Bear abilities");
    const heroNames = new Set(r.abilities.map((a) => a.name));
    const shared = r.spiritBear.filter((a) => heroNames.has(a.name));
    for (const a of r.spiritBear.filter((x) => !heroNames.has(x.name))) {
      L.push(...abilityBlock(a, "###"));
      if (a.scepter) L.push(`Bear's Scepter: ${a.scepter}`);
      if (a.shard) L.push(`Bear's Shard: ${a.shard}`);
      L.push("");
    }
    if (shared.length) L.push(`Also has ${shared.map((a) => a.name).join(", ")} (same name as Lone Druid's; see --json for the bear's copies).`, "");
  }

  L.push("## Talents", "| Level | Option | Option |", "| --: | --- | --- |");
  for (const lvl of [25, 20, 15, 10]) {
    const pair = r.talents.filter((t) => t.level === lvl).map((t) => t.name.replace(/\|/g, "\\|"));
    if (pair.length) L.push(`| ${lvl} | ${pair.join(" | ")} |`);
  }
  L.push(r.talentCheck, "");

  L.push("## Facets", r.facets.note, "");
  for (const n of r.notes) L.push(`Note: ${n}`);
  L.push(sourceLine("Valve datafeed herodata (current game values)", `roles: ${r.rolesSource}`));
  return L.join("\n");
}

export async function run(argv: string[]): Promise<string> {
  const args = parseCli(USAGE, {}, argv);
  const input = args.positionals.join(" ").trim();
  if (!input) throw new DotaError(`No hero given.\nUsage: ${USAGE}`);
  const hero = await resolveHero(input);
  const result = await build(hero);
  return output(args, result, () => markdown(result));
}

if (import.meta.main) await main(() => run(Bun.argv.slice(2)));
