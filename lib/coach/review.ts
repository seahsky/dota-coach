import Anthropic from "@anthropic-ai/sdk";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { run as getMatch } from "../../tools/GetMatch.ts";
import { run as replayMap } from "../../tools/ReplayMap.ts";
import { DotaError } from "../errors.ts";
import { fetchMatch } from "../match.ts";
import { getPlayer, rankName } from "../players.ts";
import { type Profile, accountName, profileAccounts } from "../profile.ts";
import { REVIEW_SYSTEM } from "./prompt.ts";
import { matchTimelines } from "./timelines.ts";
import { TOOLS, type ToolContext, runTool } from "./tools.ts";

/**
 * The automatic post-game review, as a LangGraph graph over the Claude API:
 *
 *   gather -> coach <-> tools
 *               \-> finish
 *
 * gather pulls the match, timelines and replay positions up front (no model turn needed),
 * coach is one Messages API call, tools runs the tool calls Claude asked for, and finish
 * keeps the text. Runs the same in Bun (the local watcher) and the Cloudflare Worker.
 */

export const DEFAULT_MODEL = "claude-opus-5-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** Model turns before the last one is told to answer without tools. */
const MAX_TURNS = 8;
/** Tool output longer than this is cut, with a note, to keep turns small. */
const MAX_TOOL_CHARS = 30_000;

export interface ReviewRequest {
  matchId: number;
  /** Account that played the match; 0 if unknown. */
  accountId: number;
  hero?: string;
  profile: Profile;
}

export interface ReviewOptions {
  apiKey?: string;
  model?: string;
  effort?: string;
  log?: (line: string) => void;
}

export interface ReviewResult {
  markdown: string;
  marks: number;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

type Msg = Anthropic.Beta.BetaMessageParam;
type Usage = ReviewResult["usage"];
const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

const State = Annotation.Root({
  messages: Annotation<Msg[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  turns: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  stop: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  model: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  review: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  usage: Annotation<Usage>({ reducer: addUsage, default: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }),
});
type S = typeof State.State;

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name]?.trim() || undefined : undefined;
}

const clip = (s: string) =>
  s.length > MAX_TOOL_CHARS ? `${s.slice(0, MAX_TOOL_CHARS)}\n[output cut at ${MAX_TOOL_CHARS} characters]` : s;

async function profileBlock(req: ReviewRequest): Promise<string> {
  const accounts = profileAccounts(req.profile);
  const lines = ["# Player"];
  if (!accounts.length) lines.push("No saved accounts.");
  for (const a of accounts) {
    const rank = await getPlayer(a.account_id)
      .then((p) => rankName(p.rank_tier, p.leaderboard_rank) ?? "unranked")
      .catch(() => "rank unknown");
    lines.push(`- ${a.role} ${a.account_id} (${accountName(a)}): ${rank}`);
  }
  const played = accounts.find((a) => a.account_id === req.accountId);
  lines.push(
    req.accountId
      ? `Played this match on account ${req.accountId}${played ? ` (${played.role}, ${accountName(played)})` : " (not a saved account)"}${req.hero ? ` as ${req.hero}` : ""}. Focus on that player.`
      : "The account that played is unknown; focus on the saved main account's player if it is in the match.",
  );
  lines.push(req.profile.notes ? `Coaching notes: ${req.profile.notes}` : "No coaching notes saved.");
  return lines.join("\n");
}

export async function reviewMatch(req: ReviewRequest, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const apiKey = opts.apiKey ?? env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new DotaError("No Anthropic API key. Set ANTHROPIC_API_KEY to write reviews with Claude.");
  const model = opts.model ?? env("DOTACOACH_MODEL") ?? DEFAULT_MODEL;
  const effortIn = opts.effort ?? env("DOTACOACH_EFFORT") ?? "high";
  if (!EFFORTS.includes(effortIn as Effort)) throw new DotaError(`DOTACOACH_EFFORT must be one of ${EFFORTS.join(", ")}.`);
  const effort = effortIn as Effort;
  const log = opts.log ?? (() => {});
  const client = new Anthropic({ apiKey });

  const accountIds = [
    ...(req.accountId ? [req.accountId] : []),
    ...profileAccounts(req.profile).map((a) => a.account_id).filter((id) => id !== req.accountId),
  ];
  const ctx: ToolContext = { matchId: req.matchId, accounts: accountIds, saved: { count: 0 } };

  async function gather(): Promise<Partial<S>> {
    log("Collecting match data...");
    const id = String(req.matchId);
    const overview = await getMatch([id, "--draft"]);
    const parsed = (await fetchMatch(id)).match.version != null;
    const parts = [await profileBlock(req), "# Match overview (GetMatch --draft)", overview];
    if (parsed) {
      parts.push("# Timelines", await matchTimelines(id));
      const focus = await replayMap([id], { accounts: async () => accountIds }).catch((e: unknown) =>
        `ReplayMap failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      parts.push("# Focus player's positions (ReplayMap)", focus);
    } else {
      parts.push("The replay is not parsed: no timelines or map positions are available.");
    }
    parts.push(`Review match ${id} now.`);
    return { messages: [{ role: "user", content: parts.join("\n\n") }] };
  }

  async function coach(state: S): Promise<Partial<S>> {
    const turn = state.turns + 1;
    const last = turn >= MAX_TURNS;
    log(last ? "Writing the review..." : `Asking Claude (turn ${turn})...`);
    const res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: REVIEW_SYSTEM,
      tools: TOOLS,
      ...(last ? { tool_choice: { type: "none" as const } } : {}),
      messages: state.messages,
      output_config: { effort },
      cache_control: { type: "ephemeral" },
      // On a policy decline, the API retries on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") {
      const why = res.stop_details?.category ? ` (${res.stop_details.category})` : "";
      throw new DotaError(`Claude declined to write this review${why}.`);
    }
    if (res.stop_reason === "max_tokens") throw new DotaError("The review hit the output limit before finishing.");
    const u = res.usage;
    return {
      messages: [{ role: "assistant", content: res.content }],
      turns: turn,
      stop: res.stop_reason,
      model: res.model,
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
    };
  }

  async function tools(state: S): Promise<Partial<S>> {
    const last = state.messages[state.messages.length - 1]!;
    const calls = (Array.isArray(last.content) ? last.content : []).filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    log(`Running ${calls.map((c) => c.name).join(", ")}`);
    // All results go back in one user message so Claude keeps making parallel calls.
    const results = await Promise.all(
      calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        try {
          const input = c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {};
          return { type: "tool_result", tool_use_id: c.id, content: clip(await runTool(c.name, input, ctx)) };
        } catch (err) {
          return { type: "tool_result", tool_use_id: c.id, is_error: true, content: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return { messages: [{ role: "user", content: results }] };
  }

  function finish(state: S): Partial<S> {
    const last = state.messages[state.messages.length - 1]!;
    const text = (Array.isArray(last.content) ? last.content : [])
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
    if (!text) throw new DotaError("Claude finished without writing a review.");
    return { review: text };
  }

  const graph = new StateGraph(State)
    .addNode("gather", gather)
    .addNode("coach", coach)
    .addNode("tools", tools)
    .addNode("finish", finish)
    .addEdge(START, "gather")
    .addEdge("gather", "coach")
    .addConditionalEdges("coach", (s: S) => (s.stop === "tool_use" ? "tools" : "finish"), ["tools", "finish"])
    .addEdge("tools", "coach")
    .addEdge("finish", END)
    .compile();

  // gather + finish + 2 steps per model turn, with room to spare.
  const out = await graph.invoke({}, { recursionLimit: MAX_TURNS * 2 + 6 });
  return { markdown: out.review, marks: ctx.saved.count, model: out.model, usage: out.usage };
}
