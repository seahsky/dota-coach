import type Anthropic from "@anthropic-ai/sdk";
import { run as getHero } from "../../tools/GetHero.ts";
import { run as getItemBuilds } from "../../tools/GetItemBuilds.ts";
import { run as getMatchups } from "../../tools/GetMatchups.ts";
import { run as getPatch } from "../../tools/GetPatch.ts";
import { run as replayMap } from "../../tools/ReplayMap.ts";
import { DotaError } from "../errors.ts";
import { saveMarkers, validateMarkers } from "../replaymap.ts";

type Tool = Anthropic.Beta.BetaTool;

const heroProp = { type: "string", description: "Hero name, id or common nickname (am, qop, wr...)." } as const;

/** Sorted by name and never changed per request, so the tools prefix stays cacheable. */
export const TOOLS: Tool[] = [
  {
    name: "get_hero",
    description: "Current abilities with values, talents by level, Aghanim's Scepter and Shard, base stats and roles for one hero (Valve datafeed, matches the live game).",
    input_schema: { type: "object", properties: { hero: heroProp }, required: ["hero"], additionalProperties: false },
  },
  {
    name: "get_item_builds",
    description: "Popular items by phase (start, 0-10, 10-25, 25+ min) for a hero from its ~100 most recent parsed league matches on OpenDota.",
    input_schema: {
      type: "object",
      properties: { hero: heroProp, top: { type: "integer", minimum: 1, maximum: 20, description: "Items per phase (default 8)." } },
      required: ["hero"],
      additionalProperties: false,
    },
  },
  {
    name: "get_matchups",
    description: "A hero's winrate against other heroes with a 95% margin and shrunk delta. Pro matches over 365 days on OpenDota, or STRATZ ranked data when a key is set. Pass vs for one specific opponent.",
    input_schema: {
      type: "object",
      properties: {
        hero: heroProp,
        vs: { type: "string", description: "Opponent hero to show first." },
        top: { type: "integer", minimum: 1, maximum: 20, description: "Rows in the best and worst lists (default 8)." },
      },
      required: ["hero"],
      additionalProperties: false,
    },
  },
  {
    name: "get_patch",
    description: "Patch notes from Valve's datafeed, latest by default, filtered to a hero or an item (full item name). Prints the release date.",
    input_schema: {
      type: "object",
      properties: {
        hero: heroProp,
        item: { type: "string", description: "Full item name, e.g. Black King Bar." },
        version: { type: "string", description: "Patch version such as 7.41c. Omit for the latest." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "replay_map",
    description: "Positional review of another player in this match (parsed replays only): deaths with nearby wards, ward lifetimes, lane position, teamfight spots. The focus player's is already in the conversation.",
    input_schema: { type: "object", properties: { hero: heroProp }, required: ["hero"], additionalProperties: false },
  },
  {
    name: "save_map_marks",
    description: "Save 2-5 coach marks for the dashboard map of this match, replacing earlier ones. Coordinates must come from replay data in this conversation.",
    input_schema: {
      type: "object",
      properties: {
        marks: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["ward", "sentry", "position", "avoid"] },
              x: { type: "number", description: "Map cell x as printed in the replay data." },
              y: { type: "number", description: "Map cell y as printed in the replay data." },
              from: { type: "number", description: "First minute the advice applies to." },
              to: { type: "number", description: "Last minute the advice applies to." },
              label: { type: "string", description: "Evidence from this match and the action, under 200 characters." },
            },
            required: ["kind", "x", "y", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["marks"],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  matchId: number;
  /** The user's account ids, main first. */
  accounts: number[];
  /** Marks saved during this review. */
  saved: { count: number };
}

const str = (input: Record<string, unknown>, key: string, required = false): string | undefined => {
  const v = input[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new DotaError(`${key} is required.`);
    return undefined;
  }
  if (typeof v !== "string" || v.length > 100) throw new DotaError(`${key} must be a short string.`);
  return v.trim();
};
const topFlag = (input: Record<string, unknown>) =>
  Number.isInteger(input.top) && (input.top as number) >= 1 && (input.top as number) <= 20 ? [`--top=${input.top}`] : [];

/** Run one tool call. Errors come back as text so Claude can adjust; the caller marks them is_error. */
export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "get_hero":
      return getHero([str(input, "hero", true)!]);
    case "get_item_builds":
      return getItemBuilds([str(input, "hero", true)!, ...topFlag(input)]);
    case "get_matchups": {
      const vs = str(input, "vs");
      return getMatchups([str(input, "hero", true)!, ...(vs ? [`--vs=${vs}`] : []), ...topFlag(input)]);
    }
    case "get_patch": {
      const hero = str(input, "hero");
      const item = str(input, "item");
      const version = str(input, "version");
      return getPatch([...(version ? [version] : []), ...(hero ? [`--hero=${hero}`] : []), ...(item ? [`--item=${item}`] : [])]);
    }
    case "replay_map":
      return replayMap([String(ctx.matchId), `--hero=${str(input, "hero", true)}`], { accounts: async () => [] });
    case "save_map_marks": {
      const markers = validateMarkers(input.marks);
      await saveMarkers(ctx.matchId, markers);
      ctx.saved.count = markers.length;
      return `Saved ${markers.length} mark(s).`;
    }
    default:
      throw new DotaError(`Unknown tool ${name}.`);
  }
}
