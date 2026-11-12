import { TTL } from "../lib/cache.ts";
import { output, parseCli, sourceLine, stripHtml } from "../lib/cli.ts";
import { DotaError, NotFoundError, RateLimitError, main } from "../lib/errors.ts";
import { heroMap, loadHeroes, resolveHero } from "../lib/heroes.ts";
import { opendota, valve } from "../lib/http.ts";
import { itemMap } from "../lib/items.ts";
import type {
  OdAbility,
  OdPatch,
  ValveAbilityList,
  ValveAbilityNotes,
  ValveHeroList,
  ValveNote,
  ValvePatchList,
  ValvePatchNotes,
} from "../lib/types.ts";

const USAGE =
  "bun run tools/GetPatch.ts [version] [--version=7.41f] [--hero=<name>] [--item=<name>] [--section=general|heroes|items|neutral|creeps] [--full] [--json]";

// ---------- Model ----------

type Direction = "buff" | "nerf" | "unclear" | "info";

interface Note {
  text: string;
  indent: number;
  /** Extra explanation Valve shows on hover. */
  info?: string;
  /** "hero" = base stats, "talent", or the ability/item name. */
  context: string;
  direction: Direction;
  /** Signed heuristic score: positive = buff, negative = nerf. */
  score: number;
}

interface Entity {
  kind: "hero" | "item" | "neutral_item";
  id: number;
  name: string;
  notes: Note[];
  /** Ability/item tags from Valve such as "New Tier 1 Artifact". */
  tags: Record<string, string>;
  verdict: "buff" | "nerf" | "mixed" | "unclear" | "unscored";
  score: number;
  /** Valve sub-heading this entry sits under, e.g. "Basic Items". */
  group?: string;
}

interface GeneralSection {
  title: string;
  notes: { text: string; indent: number; info?: string; subtitle?: boolean }[];
}

interface Patch {
  source: string;
  fallbackReason?: string;
  version: string;
  date: string | null;
  laterPatches: string[];
  recentPatches: string[];
  general: GeneralSection[];
  heroes: Entity[];
  items: Entity[];
  itemGroups: GeneralSection[];
  neutralItems: Entity[];
  neutralGroups: GeneralSection[];
  neutralCreeps: { name: string; notes: string[] }[];
}

// ---------- Version handling ----------

/** "741f", "7.41F", "v7.41f", "7_41" -> "7.41f". Returns null if it doesn't look like a version. */
export function normalizeVersion(input: string): string | null {
  return versionCandidates(input)[0] ?? null;
}

// A one-digit minor is ambiguous: "7.4" could mean 7.04 or 7.40. Try both, zero-padded first.
function versionCandidates(input: string): string[] {
  const s = input.trim().toLowerCase().replace(/^v/, "").replace(/_/g, ".");
  const m = s.match(/^(\d)\.?(\d{1,2})([a-z]?)$/);
  if (!m) return [];
  const minor = m[2]!;
  const forms = minor.length === 1 ? [`0${minor}`, `${minor}0`] : [minor];
  return forms.map((f) => `${m[1]}.${f}${m[3]}`);
}

function pickVersion(available: string[], requested: string | undefined): string {
  const recent = available.slice(-5).reverse().join(", ");
  if (!requested || requested.toLowerCase() === "latest") return available[available.length - 1]!;
  const cands = versionCandidates(requested);
  if (!cands.length) throw new DotaError(`"${requested}" is not a patch version (try 7.41 or 7.41f). Most recent: ${recent}.`);
  const hit = cands.find((c) => available.includes(c));
  if (hit) return hit;
  throw new NotFoundError(`Patch ${cands.join(" or ")} not found. Most recent patches: ${recent}.`);
}

// ---------- Change-line heuristic ----------

const VERB_RE = /^(.*?)\s+(increased|decreased|reduced|lowered|raised|improved)\s+(from|by)\s+(.*)$/i;
const UNCLEAR_RE = /\b(rescaled|reworked|replaced with|changed from|changed to|now|no longer|removed|new|moved)\b/i;
// Lower is better for these. Checked after HIGHER_FIRST so "cooldown reduction" stays higher-is-better.
const LOWER_BETTER =
  /cooldown|mana cost|health cost|manacost|\bcost\b|cast point|attack point|cast time|channel(ing)? time|restore time|replenish|recharge|charge time|respawn|\bdelay\b|(?<!\/)self[- ](damage|slow)|on self|loss on death|resistance loss|charge loss|time until|damage taken|incoming damage|base attack time|\bbat\b|fade time|backswing|buyback|travel time|wind[- ]?up|bounty lost/i;
// Drawback-or-effect words whose polarity depends on who they apply to; left unscored.
const AMBIGUOUS = /\bpenalty\b|\bloss\b/i;
const HIGHER_FIRST = /reduction|amplification|\breduce/i;
const FORMULA_RE = /\bper\b|\bat level\b|\d\s*[+*x]\s*\d|\(/i;
const DEFAULT_MAG = 0.15;

function avgValue(raw: string): number | null {
  const v = raw.replace(/(\d)\s*[-–]\s*(?=\d)/g, "$1/");
  const nums = [...v.matchAll(/\d*\.?\d+/g)].map((m) => Number(m[0]));
  if (!nums.length || nums.some((n) => !Number.isFinite(n))) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Cut a value phrase at trailing commentary: "5200g (due to ...)", "13 at level 30". */
function valuePart(s: string): string {
  return s.split(/\s+\(|,\s|\s+(?:for|when|if|on|against|with)\s/i)[0]!.trim();
}

function scoreSentence(s: string): { dir: number; mag: number } | "ambiguous" | null {
  const m = s.match(VERB_RE);
  if (!m) return null;
  const subject = m[1]!;
  // Ability descriptions ("..., the curse damage and radius will be increased by 66%") are not change lines.
  if (subject.includes(",") || /\b(is|are|be|was)$/i.test(subject)) return null;
  // Polarity belongs to the head noun: "DPS per cooldown" is DPS, not a cooldown.
  const head = subject.replace(/\s+per\s+.*$/i, "");
  if (AMBIGUOUS.test(head) && !LOWER_BETTER.test(head)) return "ambiguous";
  const verb = m[2]!.toLowerCase();
  const verbUp = verb === "increased" || verb === "raised" || verb === "improved";
  const polarity = verb === "improved" ? 1 : HIGHER_FIRST.test(head) ? 1 : LOWER_BETTER.test(head) ? -1 : 1;
  let mag = DEFAULT_MAG;
  if (m[3]!.toLowerCase() === "from") {
    const [fromRaw, toRaw] = m[4]!.split(/\s+to\s+/i);
    // Test each side alone: joined, "+0.8" and "+0.6" would look like the formula "0.8 +0.6".
    if (fromRaw && toRaw && !FORMULA_RE.test(fromRaw) && !FORMULA_RE.test(valuePart(toRaw))) {
      const a = avgValue(fromRaw);
      const b = avgValue(valuePart(toRaw));
      if (a !== null && b !== null) mag = a === 0 ? 1 : Math.min(Math.abs(b - a) / Math.abs(a), 1);
    }
  }
  return { dir: polarity * (verbUp ? 1 : -1), mag };
}

/** Classify one note line. Weight lowers sub-notes and talents so they don't dominate. */
export function classify(text: string, weight: number): { direction: Direction; score: number } {
  let sentences = text.split(/\.\s+(?=[A-Z])/);
  // Item notes often say "Recipe cost ... Total cost ..."; only the total matters.
  const total = sentences.filter((s) => /^total cost/i.test(s));
  if (total.length) sentences = total;
  let score = 0;
  let scored = false;
  let ambiguous = false;
  for (const s of sentences) {
    const r = scoreSentence(s);
    if (r === "ambiguous") ambiguous = true;
    else if (r) {
      score += r.dir * r.mag;
      scored = true;
    }
  }
  if (scored) {
    score = Math.max(-1, Math.min(1, score)) * weight;
    if (score === 0) return { direction: "info", score: 0 };
    return { direction: score > 0 ? "buff" : "nerf", score };
  }
  if (/\bunchanged\b/i.test(text)) return { direction: "info", score: 0 };
  if (ambiguous || UNCLEAR_RE.test(text) || /\b(increased|decreased|reduced|lowered|raised|improved)\b/i.test(text)) return { direction: "unclear", score: 0 };
  return { direction: "info", score: 0 };
}

function makeNote(raw: string, indent: number, context: string, extraWeight = 1, info?: string): Note | null {
  const text = stripHtml(raw);
  if (!text) return null;
  const derived = /^damage (at level 1|gain per level)/i.test(text);
  const weight = (indent >= 2 ? 0.5 : 1) * extraWeight * (derived ? 0 : 1);
  const c = indent >= 2 && !derived ? classifyIndented(text, weight) : classify(text, weight);
  return { text, indent, context, direction: derived ? "info" : c.direction, score: Math.round(c.score * 1000) / 1000, ...(info ? { info: stripHtml(info) } : {}) };
}

// Sub-notes describing new behaviour ("Increases Max Mana Burned ...") aren't change lines; don't flag them unclear.
function classifyIndented(text: string, weight: number) {
  const c = classify(text, weight);
  return c.direction === "unclear" ? { direction: "info" as Direction, score: 0 } : c;
}

function finish(e: Omit<Entity, "verdict" | "score">): Entity {
  // Swapped talents are routine in big patches; they shouldn't make a hero read as reworked.
  const top = e.notes.filter((n) => n.indent <= 1 && n.context !== "talent");
  const scored = e.notes.filter((n) => n.direction === "buff" || n.direction === "nerf");
  const unclear = top.filter((n) => n.direction === "unclear").length;
  const score = scored.reduce((a, n) => a + n.score, 0);
  const gross = scored.reduce((a, n) => a + Math.abs(n.score), 0);
  let verdict: Entity["verdict"];
  if (!scored.length) verdict = unclear ? "unclear" : "unscored";
  else if (unclear > 2 * scored.length) verdict = "unclear";
  // Buffs and nerfs that roughly cancel out.
  else if (Math.abs(score) < 0.25 * gross) verdict = "mixed";
  else verdict = score > 0 ? "buff" : "nerf";
  return { ...e, verdict, score: Math.round(score * 1000) / 1000 };
}

// ---------- Valve source ----------

async function valveNames(path: string): Promise<Map<number, string>> {
  const raw = await valve<ValveAbilityList>(`${path}?language=english`, { ttl: TTL.constants });
  return new Map(raw.result.data.itemabilities.map((a) => [a.id, a.name_english_loc || a.name_loc || a.name]));
}

async function heroNames(): Promise<Map<number, string>> {
  try {
    return new Map([...(await heroMap())].map(([id, h]) => [id, h.name]));
  } catch {
    const raw = await valve<ValveHeroList>("/herolist?language=english", { ttl: TTL.constants });
    return new Map(raw.result.data.heroes.map((h) => [h.id, h.name_english_loc || h.name_loc]));
  }
}

function groupedEntities(
  list: ValveAbilityNotes[] | undefined,
  kind: Entity["kind"],
  names: Map<number, string>,
): { entities: Entity[]; groups: GeneralSection[] } {
  const entities: Entity[] = [];
  const groups: GeneralSection[] = [];
  let group: string | undefined;
  for (const x of list ?? []) {
    if (x.ability_id <= 0 || x.is_general_note) {
      group = stripHtml(x.title ?? "General");
      groups.push({
        title: group,
        notes: (x.ability_notes ?? []).map((n) => ({ text: stripHtml(n.note), indent: n.indent_level })).filter((n) => n.text),
      });
      continue;
    }
    const name = names.get(x.ability_id) ?? `${kind === "hero" ? "Ability" : "Item"} #${x.ability_id}`;
    const notes = (x.ability_notes ?? []).map((n) => makeNote(n.note, n.indent_level, name, 1, n.info)).filter((n): n is Note => !!n);
    const prev = entities.find((e) => e.id === x.ability_id);
    if (prev) prev.notes.push(...notes);
    else
      entities.push({
        kind,
        id: x.ability_id,
        name,
        notes,
        tags: x.title ? { [name]: stripHtml(x.title) } : {},
        verdict: "unclear",
        score: 0,
        ...(group ? { group } : {}),
      });
  }
  return { entities: entities.map(finish), groups };
}

async function fromValve(requested: string | undefined): Promise<Patch> {
  const list = await valve<ValvePatchList>("/patchnoteslist?language=english", { ttl: TTL.patch });
  const patches = [...list.patches].sort((a, b) => a.patch_timestamp - b.patch_timestamp);
  const versions = patches.map((p) => p.patch_number);
  const version = pickVersion(versions, requested);
  const notes = await valve<ValvePatchNotes>(`/patchnotes?version=${encodeURIComponent(version)}&language=english`, {
    ttl: TTL.patch,
    what: `Patch ${version}`,
  });
  if (!notes.success) throw new DotaError(`Valve datafeed has no notes for ${version}.`);

  const [abilities, itemNames, heroes] = await Promise.all([valveNames("/abilitylist"), valveNames("/itemlist"), heroNames()]);
  const ts = notes.patch_timestamp || patches.find((p) => p.patch_number === version)?.patch_timestamp;

  const heroEntities: Entity[] = (notes.heroes ?? []).map((h) => {
    const hn = (h.hero_notes ?? []).map((n) => makeNote(n.note, n.indent_level, "hero", 1, n.info));
    const tn = (h.talent_notes ?? []).map((n) => makeNote(n.note, n.indent_level, "talent", 0.5, n.info));
    const an: (Note | null)[] = [];
    const tags: Record<string, string> = {};
    for (const a of h.abilities ?? []) {
      const name = abilities.get(a.ability_id) ?? `Ability #${a.ability_id}`;
      if (a.title) tags[name] = stripHtml(a.title);
      for (const n of a.ability_notes ?? []) {
        const agh = (n as ValveNote & { aghanims?: string }).aghanims || /^aghanim/i.test(stripHtml(n.note)) ? 0.7 : 1;
        an.push(makeNote(n.note, n.indent_level, name, agh, n.info));
      }
    }
    return finish({
      kind: "hero",
      id: h.hero_id,
      name: heroes.get(h.hero_id) ?? `Hero #${h.hero_id}`,
      notes: [...hn, ...tn, ...an].filter((n): n is Note => !!n),
      tags,
    });
  });
  heroEntities.sort((a, b) => a.name.localeCompare(b.name));

  const items = groupedEntities(notes.items, "item", itemNames);
  const neutral = groupedEntities(notes.neutral_items, "neutral_item", itemNames);
  const idx = versions.indexOf(version);

  return {
    source: `Valve datafeed (patchnotes?version=${version})`,
    version,
    date: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null,
    laterPatches: versions.slice(idx + 1),
    recentPatches: versions.slice(-5).reverse(),
    general: (notes.general_notes ?? []).map((g) => ({
      title: stripHtml(g.title ?? "General"),
      notes: g.generic
        .map((n) => ({
          text: stripHtml(n.note),
          indent: n.indent_level,
          ...(n.info ? { info: stripHtml(n.info) } : {}),
          ...(n.hide_dot && /Subtitle/.test(n.note) ? { subtitle: true } : {}),
        }))
        .filter((n) => n.text),
    })),
    heroes: heroEntities,
    items: items.entities,
    itemGroups: items.groups,
    neutralItems: neutral.entities,
    neutralGroups: neutral.groups,
    neutralCreeps: (notes.neutral_creeps ?? []).map((c) => ({
      name: c.localized_name,
      notes: c.neutral_creep_notes.map((n) => stripHtml(n.note)).filter(Boolean),
    })),
  };
}

// ---------- OpenDota fallback ----------

/** GET /constants/patchnotes -> Record<"7_41", OdPatchNotes>. Verified shape 2026-11-11. */
interface OdPatchNotes {
  general?: string[];
  items?: Record<string, string[]>;
  /** Keyed by hero key ("antimage"); "misc" holds shop/neutral notes. Inner keys: "general", "talents", or ability keys. */
  heroes?: Record<string, Record<string, string[]> | string[]>;
}

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function fromOpenDota(requested: string | undefined, reason: string): Promise<Patch> {
  const all = await opendota<Record<string, OdPatchNotes>>("/constants/patchnotes", { ttl: TTL.patch });
  const versions = Object.keys(all).map((k) => k.replace(/_/g, "."));
  let version: string;
  try {
    version = pickVersion(versions, requested);
  } catch (err) {
    throw new DotaError(`Valve datafeed failed (${reason}). OpenDota fallback cannot help either: ${(err as Error).message}`);
  }
  const raw = all[version.replace(/\./g, "_")]!;

  const [heroes, items, abilities, patchDates] = await Promise.all([
    loadHeroes(),
    itemMap().catch(() => new Map()),
    opendota<Record<string, OdAbility>>("/constants/abilities", { ttl: TTL.constants }).catch(() => ({}) as Record<string, OdAbility>),
    opendota<OdPatch[]>("/constants/patch", { ttl: TTL.constants }).catch(() => [] as OdPatch[]),
  ]);
  const heroByKey = new Map(heroes.map((h) => [h.key, h]));
  const itemByKey = new Map([...items.values()].map((i) => [i.key, i]));

  const heroEntities: Entity[] = [];
  const misc: GeneralSection[] = [];
  for (const [key, val] of Object.entries(raw.heroes ?? {})) {
    if (Array.isArray(val)) {
      misc.push({ title: titleCase(key), notes: val.map((t) => ({ text: stripHtml(t), indent: 1 })).filter((n) => n.text) });
      continue;
    }
    const h = heroByKey.get(key);
    const notes: Note[] = [];
    for (const [sub, lines] of Object.entries(val)) {
      const context =
        sub === "general" ? "hero" : sub === "talents" ? "talent" : abilities[sub]?.dname ?? titleCase(sub.replace(`${key}_`, ""));
      for (const l of lines) {
        const n = makeNote(l, 1, context, sub === "talents" ? 0.5 : 1);
        if (n) notes.push(n);
      }
    }
    heroEntities.push(finish({ kind: "hero", id: h?.id ?? 0, name: h?.name ?? titleCase(key), notes, tags: {} }));
  }
  heroEntities.sort((a, b) => a.name.localeCompare(b.name));

  const itemEntities = Object.entries(raw.items ?? {}).map(([key, lines]) => {
    const it = itemByKey.get(key);
    const name = it?.name ?? titleCase(key);
    return finish({
      kind: "item",
      id: it?.id ?? 0,
      name,
      notes: lines.map((l) => makeNote(l, 1, name)).filter((n): n is Note => !!n),
      tags: {},
    });
  });

  const date = patchDates.find((p) => p.name === version)?.date?.slice(0, 10) ?? null;
  const idx = versions.indexOf(version);
  return {
    source: "OpenDota (/constants/patchnotes)",
    fallbackReason: reason,
    version,
    date,
    laterPatches: versions.slice(idx + 1),
    recentPatches: versions.slice(-5).reverse(),
    // OpenDota flattens section titles into the list, so they can't be told apart from notes.
    general: raw.general?.length ? [{ title: "General", notes: raw.general.map((t) => ({ text: stripHtml(t), indent: 1 })).filter((n) => n.text) }] : [],
    heroes: heroEntities,
    items: itemEntities,
    itemGroups: [],
    neutralItems: [],
    neutralGroups: misc,
    neutralCreeps: [],
  };
}

async function loadPatch(requested: string | undefined): Promise<Patch> {
  try {
    return await fromValve(requested);
  } catch (err) {
    // A bad version is the user's error, not an outage; don't mask it with a fallback.
    if (err instanceof NotFoundError || (err instanceof DotaError && /not a patch version/.test(err.message))) throw err;
    if (!(err instanceof DotaError) && !(err instanceof TypeError)) throw err;
    const reason = err instanceof RateLimitError ? "rate limited" : err.message.split(/\.\s/)[0]!.replace(/\.$/, "");
    try {
      return await fromOpenDota(requested, reason);
    } catch (fallbackErr) {
      if (fallbackErr instanceof NotFoundError) throw fallbackErr;
      const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new DotaError(`Valve datafeed failed (${reason}); OpenDota fallback also failed: ${msg}`);
    }
  }
}

// ---------- Filters ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function applyFilters(p: Patch, hero: { id: number; name: string } | null, item: string | undefined): Patch {
  if (!hero && !item) return p;
  const q = item ? norm(item) : "";
  const matchItem = (e: Entity) => norm(e.name) === q || norm(e.name).includes(q);
  return {
    ...p,
    general: [],
    heroes: hero ? p.heroes.filter((h) => h.id === hero.id || norm(h.name) === norm(hero.name)) : [],
    items: item ? p.items.filter(matchItem) : [],
    itemGroups: [],
    neutralItems: item ? p.neutralItems.filter(matchItem) : [],
    neutralGroups: [],
    neutralCreeps: [],
  };
}

// ---------- Rendering ----------

interface Ranked {
  name: string;
  kind: Entity["kind"];
  score: number;
  drivers: string[];
}

function rank(entities: Entity[]) {
  const toRanked = (e: Entity, sign: number): Ranked => ({
    name: e.name,
    kind: e.kind,
    score: e.score,
    drivers: e.notes
      .filter((n) => Math.sign(n.score) === sign)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 2)
      .map((n) => noteLabel(n, e.name)),
  });
  return {
    buffs: entities.filter((e) => e.verdict === "buff").sort((a, b) => b.score - a.score).slice(0, 5).map((e) => toRanked(e, 1)),
    nerfs: entities.filter((e) => e.verdict === "nerf").sort((a, b) => a.score - b.score).slice(0, 5).map((e) => toRanked(e, -1)),
    unclear: entities
      .filter((e) => e.verdict === "unclear")
      .map((e) => ({ name: e.name, unclearLines: e.notes.filter((n) => n.direction === "unclear").length }))
      .sort((a, b) => b.unclearLines - a.unclearLines),
    mixed: entities.filter((e) => e.verdict === "mixed").map((e) => e.name),
  };
}

function noteLabel(n: Note, owner: string): string {
  if (n.context === "hero" || n.context === "talent" || n.context === owner) return n.text;
  if (n.text.toLowerCase().startsWith(n.context.toLowerCase())) return n.text;
  return `${n.context}: ${n.text}`;
}

function summary(p: Patch) {
  return {
    heuristic: true,
    heroes: rank(p.heroes),
    items: rank([...p.items, ...p.neutralItems]),
  };
}

const MARK: Record<Direction, string> = { buff: " (+)", nerf: " (-)", unclear: " (?)", info: "" };
const TRUNC = 180;
const clip = (s: string) => (s.length > TRUNC ? s.slice(0, TRUNC - 3).trimEnd() + "..." : s);

function bullet(text: string, indent: number, info?: string, showInfo = true): string {
  const pad = "  ".repeat(Math.max(0, indent - 1));
  return `${pad}- ${text}${info && showInfo ? ` _(${clip(info)})_` : ""}`;
}

function renderEntityNotes(e: Entity, showInfo: boolean): string[] {
  const out: string[] = [];
  let lastCtx = "";
  const ctxLabel = (c: string) => (c === "hero" ? "Base stats" : c === "talent" ? "Talents" : c);
  const multiCtx = new Set(e.notes.map((n) => n.context)).size > 1 || e.kind === "hero";
  const perCtx = new Map<string, number>();
  for (const n of e.notes) perCtx.set(n.context, (perCtx.get(n.context) ?? 0) + 1);
  for (const n of e.notes) {
    const text = `${n.text}${MARK[n.direction]}`;
    const tag = e.tags[n.context];
    const head = `**${ctxLabel(n.context)}**${tag ? ` _${tag}_` : ""}`;
    if (multiCtx && perCtx.get(n.context) === 1) {
      out.push(bullet(`${head}: ${text}`, n.indent, n.info, showInfo));
      continue;
    }
    if (multiCtx && n.context !== lastCtx) {
      out.push(`- ${head}`);
      lastCtx = n.context;
    }
    out.push(bullet(text, n.indent + (multiCtx ? 1 : 0), n.info, showInfo));
  }
  return out;
}

function renderGroups(groups: GeneralSection[], showInfo: boolean, maxPer?: number): string[] {
  const out: string[] = [];
  for (const g of groups) {
    const notes = g.notes.filter((n) => n.text);
    out.push(`**${g.title}**${maxPer !== undefined && notes.length > maxPer ? ` (${notes.length} notes, showing ${maxPer})` : ""}`);
    for (const n of maxPer !== undefined ? notes.slice(0, maxPer) : notes) {
      out.push(n.subtitle ? `- _${n.text}_` : bullet(n.text, n.indent, n.info, showInfo));
    }
    out.push("");
  }
  return out;
}

function renderRanked(title: string, r: ReturnType<typeof rank>, noun: string): string[] {
  const out: string[] = [];
  if (!r.buffs.length && !r.nerfs.length && !r.unclear.length) return out;
  out.push(`### ${title}`);
  const fmt = (x: Ranked, i: number) => [
    `${i + 1}. **${x.name}** (${x.score > 0 ? "+" : ""}${x.score.toFixed(2)})`,
    ...x.drivers.map((d) => `   - ${clip(d)}`),
  ];
  out.push("Biggest buffs:", ...(r.buffs.length ? r.buffs.flatMap(fmt) : ["- none detected"]));
  out.push("", "Biggest nerfs:", ...(r.nerfs.length ? r.nerfs.flatMap(fmt) : ["- none detected"]));
  if (r.unclear.length) {
    const shown = r.unclear.slice(0, 12).map((u) => u.name);
    const more = r.unclear.length - shown.length;
    out.push("", `Mostly reworked or unclear ${noun}: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
  }
  if (r.mixed.length) out.push(`Mixed (buffs and nerfs roughly cancel): ${clip(r.mixed.join(", "))}`);
  out.push("");
  return out;
}

function lineCount(p: Patch): number {
  return (
    p.general.reduce((a, g) => a + g.notes.length, 0) +
    [...p.heroes, ...p.items, ...p.neutralItems].reduce((a, e) => a + e.notes.length, 0) +
    p.neutralCreeps.reduce((a, c) => a + c.notes.length, 0)
  );
}

type Section = "general" | "heroes" | "items" | "neutral" | "creeps";

interface RenderOpts {
  full: boolean;
  section?: Section;
  filtered: boolean;
  heroLabel?: string;
  itemLabel?: string;
  lastChanged?: string | null;
}

export function render(p: Patch, opts: RenderOpts): string {
  const out: string[] = [];
  const total = lineCount(p);
  const compact = !opts.full && !opts.filtered && !opts.section && total > 150;
  const show = (s: Section) => !opts.section || opts.section === s;

  out.push(`# Patch ${p.version}${p.date ? ` (released ${p.date})` : ""}`);
  out.push(
    sourceLine(p.source, p.fallbackReason ? `fallback because Valve datafeed failed: ${p.fallbackReason}` : undefined),
  );
  if (p.laterPatches.length) out.push(`Newer patches exist: ${p.laterPatches.join(", ")}.`);
  else out.push(p.fallbackReason ? "This is the latest patch in OpenDota's copy." : "This is the latest patch.");
  if (p.fallbackReason) out.push("OpenDota's copy can lag behind Valve's letter patches and has no neutral creep section.");
  out.push("");

  if (opts.filtered) {
    if (opts.heroLabel && !p.heroes.length) {
      out.push(`No hero-specific changes to ${opts.heroLabel} in ${p.version}. General and item changes can still affect the hero.`);
      if (opts.lastChanged) out.push(`Most recent earlier patch that changed ${opts.heroLabel}: ${opts.lastChanged} (run with --version=${opts.lastChanged}).`);
      else if (opts.lastChanged === null) out.push(`No changes to ${opts.heroLabel} in the ${LOOKBACK} patches before ${p.version} either.`);
      out.push("");
    }
    if (opts.itemLabel && !p.items.length && !p.neutralItems.length) out.push(`No item changes matching "${opts.itemLabel}" in ${p.version}.`, "");
  }

  if (!opts.section) {
    const s = summary(p);
    if (p.heroes.length + p.items.length + p.neutralItems.length > 0 && !opts.filtered) {
      out.push("## Buffs and nerfs (heuristic)");
      out.push(
        "_Each \"X increased/decreased from A to B\" line is scored by whether that stat is better higher or lower (cooldowns and costs lower, most else higher) times its relative change. Talents, sub-notes and Aghanim's lines count less. Rescaled, replaced, reworked, new and removed lines are not scored. Treat this as a starting point, not a verdict._",
        "",
      );
      out.push(...renderRanked("Heroes", s.heroes, "heroes"));
      out.push(...renderRanked("Items", s.items, "items"));
    } else if (opts.filtered) {
      for (const e of [...p.heroes, ...p.items, ...p.neutralItems]) {
        out.push(`Heuristic verdict for ${e.name}: **${e.verdict}** (score ${e.score > 0 ? "+" : ""}${e.score.toFixed(2)}).`);
      }
      out.push("");
    }
  }

  if (p.general.length && show("general")) {
    out.push("## General", "");
    out.push(...renderGroups(p.general, !compact, compact ? 3 : undefined));
  }

  if (p.heroes.length && show("heroes")) {
    out.push(`## Heroes (${p.heroes.length})`, "");
    if (compact) {
      const by = (v: Entity["verdict"]) => p.heroes.filter((h) => h.verdict === v).map((h) => h.name);
      const labels: [Entity["verdict"], string][] = [["buff", "Net buff"], ["nerf", "Net nerf"], ["mixed", "Mixed"], ["unclear", "Reworked/unclear"], ["unscored", "No scored change"]];
      for (const [v, label] of labels) {
        const names = by(v);
        if (names.length) out.push(`- **${label}** (${names.length}): ${names.join(", ")}`);
      }
      out.push("");
    } else {
      for (const h of p.heroes) out.push(`### ${h.name}`, ...renderEntityNotes(h, true), "");
    }
  }

  const itemBlock = (title: string, groups: GeneralSection[], ents: Entity[]) => {
    if (!groups.length && !ents.length) return;
    out.push(`## ${title}`, "");
    const blocks: { group?: GeneralSection; ents: Entity[] }[] = [
      { ents: ents.filter((e) => !e.group || !groups.some((g) => g.title === e.group)) },
      ...groups.map((g) => ({ group: g, ents: ents.filter((e) => e.group === g.title) })),
    ];
    for (const b of blocks) {
      if (b.group) out.push(...renderGroups([b.group], !compact, compact ? 3 : undefined).slice(0, -1));
      if (!b.ents.length) {
        if (b.group) out.push("");
        continue;
      }
      if (compact) {
        out.push(b.ents.map((e) => (e.verdict === "unscored" ? e.name : `${e.name} [${e.verdict}]`)).join(", "), "");
        continue;
      }
      if (b.group) out.push("");
      for (const e of b.ents) {
        const tag = e.tags[e.name];
        out.push(`**${e.name}**${tag ? ` _${tag}_` : ""}`, ...renderEntityNotes(e, true), "");
      }
    }
  };
  if (show("items")) itemBlock("Items", p.itemGroups, p.items);
  if (show("neutral")) itemBlock(p.fallbackReason ? "Other (OpenDota 'misc')" : "Neutral items", p.neutralGroups, p.neutralItems);

  if (p.neutralCreeps.length && show("creeps")) {
    out.push("## Neutral creeps", "");
    if (compact) out.push(p.neutralCreeps.map((c) => c.name).join(", "), "");
    else for (const c of p.neutralCreeps) out.push(`**${c.name}**`, ...c.notes.map((n) => `- ${n}`), "");
  }

  if (opts.section) {
    const has: Record<Section, boolean> = {
      general: p.general.length > 0,
      heroes: p.heroes.length > 0,
      items: p.items.length + p.itemGroups.length > 0,
      neutral: p.neutralItems.length + p.neutralGroups.length > 0,
      creeps: p.neutralCreeps.length > 0,
    };
    if (!has[opts.section]) out.push(`No ${opts.section === "neutral" ? "neutral item" : opts.section === "creeps" ? "neutral creep" : opts.section} notes in ${p.version}.`);
  }

  if (compact) {
    out.push(
      `_Compact view of a large patch (${total} lines). Use --hero=<name>, --item=<name>, --section=general|heroes|items|neutral|creeps, or --full for everything._`,
    );
  } else if (!opts.filtered) {
    out.push(opts.section ? "_(+) buff, (-) nerf, (?) unclear by a heuristic over \"increased/decreased from A to B\" lines; run without --section for the method._" : "_(+) buff, (-) nerf, (?) unclear by the heuristic above._");
  }
  return out.join("\n");
}

const LOOKBACK = 8;

/** Walk back through earlier Valve patches to find the last one that touched this hero. */
async function lastHeroChange(heroId: number, version: string): Promise<string | null | undefined> {
  try {
    const list = await valve<ValvePatchList>("/patchnoteslist?language=english", { ttl: TTL.patch });
    const versions = [...list.patches].sort((a, b) => a.patch_timestamp - b.patch_timestamp).map((p) => p.patch_number);
    const idx = versions.indexOf(version);
    for (const v of versions.slice(Math.max(0, idx - LOOKBACK), idx).reverse()) {
      const n = await valve<ValvePatchNotes>(`/patchnotes?version=${encodeURIComponent(v)}&language=english`, { ttl: TTL.patch });
      if (n.heroes?.some((h) => h.hero_id === heroId)) return v;
    }
    return null;
  } catch {
    return undefined;
  }
}

// ---------- Entry ----------

const SECTIONS: Section[] = ["general", "heroes", "items", "neutral", "creeps"];

export async function run(argv: string[]): Promise<string> {
  const args = parseCli(USAGE, { strings: ["version", "hero", "item", "section"], booleans: ["full"] }, argv);
  const versionArg = (args.flags.version as string | undefined) ?? args.positionals[0];
  const section = args.flags.section as string | undefined;
  if (section && !SECTIONS.includes(section as Section)) {
    throw new DotaError(`--section must be one of ${SECTIONS.join(", ")} (got "${section}").`);
  }
  const heroArg = args.flags.hero as string | undefined;
  const itemArg = args.flags.item as string | undefined;
  const hero = heroArg ? await resolveHero(heroArg) : null;

  const patch = applyFilters(await loadPatch(versionArg), hero, itemArg);
  const lastChanged = hero && !patch.heroes.length && !patch.fallbackReason ? await lastHeroChange(hero.id, patch.version) : undefined;

  if (itemArg && !patch.items.length && !patch.neutralItems.length) {
    const known = await valveNames("/itemlist").catch(() => null);
    const q = norm(itemArg);
    if (known && ![...known.values()].some((n) => norm(n).includes(q))) {
      throw new NotFoundError(`Unknown item "${itemArg}".`);
    }
  }

  const data = {
    ...patch,
    ...(section ? { section } : {}),
    ...(lastChanged !== undefined ? { heroLastChangedIn: lastChanged } : {}),
    summary: summary(patch),
  };
  return output(args, data, () =>
    render(patch, {
      full: Boolean(args.flags.full),
      section: section as Section | undefined,
      filtered: Boolean(hero || itemArg),
      heroLabel: hero?.name,
      lastChanged,
      itemLabel: itemArg,
    }),
  );
}

if (import.meta.main) await main(() => run(Bun.argv.slice(2)));
