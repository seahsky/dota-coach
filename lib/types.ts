// Response shapes, written from live responses captured on 2026-11-11.
// Only fields the tools use are typed; the APIs return more.

// ---------- OpenDota ----------

/** GET /constants/heroes -> Record<string id, OdHero> */
export interface OdHero {
  id: number;
  name: string; // npc_dota_hero_antimage
  localized_name: string;
  primary_attr: "str" | "agi" | "int" | "all";
  attack_type: "Melee" | "Ranged";
  roles: string[];
  base_health: number;
  base_health_regen: number;
  base_mana: number;
  base_mana_regen: number;
  base_armor: number;
  base_mr: number;
  base_attack_min: number;
  base_attack_max: number;
  base_str: number;
  base_agi: number;
  base_int: number;
  str_gain: number;
  agi_gain: number;
  int_gain: number;
  attack_range: number;
  projectile_speed: number;
  attack_rate: number;
  attack_point: number;
  move_speed: number;
  turn_rate: number | null;
  day_vision: number;
  night_vision: number;
}

/**
 * GET /heroStats -> OdHeroStats[]. `${n}_pick` / `${n}_win` for rank brackets
 * 1..8 (1 Herald ... 8 Immortal). Bracket 8 was all zeros on 2026-11-11,
 * so 7 appears to cover Divine and Immortal together.
 */
export interface OdHeroStats extends OdHero {
  pro_pick: number;
  pro_win: number;
  pro_ban: number;
  pub_pick: number;
  pub_win: number;
  pub_pick_trend: number[];
  pub_win_trend: number[];
  turbo_picks: number;
  turbo_wins: number;
  [bracketKey: `${number}_pick` | `${number}_win`]: number;
}

/** GET /heroes/{id}/matchups -> OdMatchup[]. `wins` are the queried hero's wins. */
export interface OdMatchup {
  hero_id: number;
  games_played: number;
  wins: number;
}

/** GET /heroes/{id}/itemPopularity. Keys are item ids (as strings), values are counts. */
export interface OdItemPopularity {
  start_game_items: Record<string, number>;
  early_game_items: Record<string, number>;
  mid_game_items: Record<string, number>;
  late_game_items: Record<string, number>;
}

/** GET /constants/hero_abilities -> Record<npc name, OdHeroAbilities> */
export interface OdHeroAbilities {
  abilities: string[];
  talents: { name: string; level: number }[];
  facets: {
    id: number;
    name: string;
    deprecated?: string;
    title: string;
    description: string;
  }[];
}

/** GET /constants/abilities -> Record<ability name, OdAbility> */
export interface OdAbility {
  dname?: string;
  behavior?: string | string[];
  dmg_type?: string;
  bkbpierce?: string;
  desc?: string;
  attrib?: { key: string; header: string; value: string | string[]; generated?: boolean }[];
  mc?: string | string[];
  cd?: string | string[];
  img?: string;
}

/** GET /constants/item_ids -> Record<string id, internal name without "item_"> */
export type OdItemIds = Record<string, string>;

/** GET /constants/items -> Record<internal name, OdItem> */
export interface OdItem {
  id: number;
  dname?: string;
  cost?: number | null;
  qual?: string;
  components?: string[] | null;
}

/** GET /constants/patch -> OdPatch[] */
export interface OdPatch {
  name: string;
  date: string;
  id: number;
}

export interface OdPickBan {
  is_pick: boolean;
  hero_id: number;
  team: 0 | 1; // 0 = Radiant, 1 = Dire
  order: number;
}

export interface OdMatchPlayer {
  player_slot: number;
  account_id?: number | null;
  hero_id: number;
  personaname?: string | null;
  name?: string | null; // pro name
  isRadiant: boolean;
  win: number;
  kills: number;
  deaths: number;
  assists: number;
  last_hits: number;
  denies: number;
  gold_per_min: number;
  xp_per_min: number;
  hero_damage: number;
  tower_damage: number;
  hero_healing: number;
  net_worth: number;
  level: number;
  item_0: number;
  item_1: number;
  item_2: number;
  item_3: number;
  item_4: number;
  item_5: number;
  backpack_0?: number;
  backpack_1?: number;
  backpack_2?: number;
  item_neutral?: number;
  aghanims_scepter?: number;
  aghanims_shard?: number;
  rank_tier?: number | null;
  // Present only on parsed matches:
  lane?: number | null;
  lane_role?: number | null;
  is_roaming?: boolean | null;
  position_est?: number | null;
  lane_efficiency_pct?: number;
  obs_placed?: number;
  sen_placed?: number;
  stuns?: number;
  teamfight_participation?: number;
}

/** GET /matches/{id} */
export interface OdMatch {
  match_id: number;
  start_time: number;
  duration: number;
  radiant_win: boolean;
  radiant_score: number;
  dire_score: number;
  game_mode: number;
  lobby_type: number;
  leagueid?: number;
  league?: { name?: string } | null;
  radiant_name?: string | null;
  dire_name?: string | null;
  radiant_team?: { name?: string } | null;
  dire_team?: { name?: string } | null;
  patch?: number;
  region?: number;
  first_blood_time?: number;
  picks_bans?: OdPickBan[] | null;
  players: OdMatchPlayer[];
  radiant_gold_adv?: number[] | null;
  radiant_xp_adv?: number[] | null;
  objectives?: { time: number; type: string; key?: string | number; slot?: number; team?: number; unit?: string }[] | null;
  teamfights?: unknown[] | null;
  version?: number | null; // non-null when the replay has been parsed
}

// ---------- Valve datafeed ----------

/** GET /patchnoteslist?language=english */
export interface ValvePatchList {
  success: boolean;
  patches: { patch_number: string; patch_name: string; patch_timestamp: number }[];
}

export interface ValveNote {
  indent_level: number;
  note: string;
  info?: string;
  hide_dot?: boolean;
  icon?: string;
}

export interface ValveAbilityNotes {
  ability_id: number;
  title?: string;
  is_general_note?: boolean;
  postfix_lines?: number;
  ability_notes?: ValveNote[];
}

/** GET /patchnotes?version=7.41f&language=english */
export interface ValvePatchNotes {
  success: boolean;
  patch_number: string;
  patch_name: string;
  patch_timestamp: number;
  general_notes?: { title?: string; generic: ValveNote[] }[];
  items?: ValveAbilityNotes[];
  neutral_items?: ValveAbilityNotes[];
  heroes?: {
    hero_id: number;
    hero_notes?: ValveNote[];
    talent_notes?: ValveNote[];
    abilities?: ValveAbilityNotes[];
  }[];
  neutral_creeps?: { name: string; localized_name: string; neutral_creep_notes: ValveNote[] }[];
}

/** GET /herolist?language=english */
export interface ValveHeroList {
  result: { data: { heroes: { id: number; name: string; name_loc: string; name_english_loc: string; primary_attr: number; complexity: number }[] } };
}

/** GET /abilitylist and /itemlist (same shape) */
export interface ValveAbilityList {
  result: { data: { itemabilities: { id: number; name: string; name_loc: string; name_english_loc: string; neutral_item_tier: number }[] } };
}

export interface ValveSpecialValue {
  name: string;
  values_float: number[];
  is_percentage: boolean;
  heading_loc: string;
  values_shard: number[];
  values_scepter: number[];
}

export interface ValveAbility {
  id: number;
  name: string;
  name_loc: string;
  desc_loc: string;
  notes_loc: string[];
  shard_loc: string;
  scepter_loc: string;
  type: number;
  behavior: string;
  damage: number;
  immunity: number;
  dispellable: number;
  max_level: number;
  cast_ranges: number[];
  cast_points: number[];
  channel_times: number[];
  cooldowns: number[];
  durations: number[];
  damages: number[];
  mana_costs: number[];
  special_values: ValveSpecialValue[];
  ability_has_scepter: boolean;
  ability_has_shard: boolean;
  ability_is_granted_by_scepter: boolean;
  ability_is_granted_by_shard: boolean;
  ability_is_innate: boolean;
}

/** GET /herodata?language=english&hero_id=N -> result.data.heroes[0] */
export interface ValveHeroData {
  id: number;
  name: string;
  name_loc: string;
  npe_desc_loc: string;
  hype_loc: string;
  str_base: number;
  str_gain: number;
  agi_base: number;
  agi_gain: number;
  int_base: number;
  int_gain: number;
  primary_attr: number;
  complexity: number;
  attack_capability: number;
  role_levels: number[];
  damage_min: number;
  damage_max: number;
  attack_rate: number;
  attack_range: number;
  projectile_speed: number;
  armor: number;
  magic_resistance: number;
  movement_speed: number;
  turn_rate: number;
  sight_range_day: number;
  sight_range_night: number;
  max_health: number;
  health_regen: number;
  max_mana: number;
  mana_regen: number;
  facets: unknown[]; // empty for every hero since 7.41 removed facets
  abilities: ValveAbility[];
  talents: ValveAbility[];
  facet_abilities: unknown[];
}
