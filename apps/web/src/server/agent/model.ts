// Which language model answers the chat. `MOCK=1` uses the scripted model:
// a `MockLanguageModelV4` that routes the last user message with `routeIntent` and streams one tool
// call (plus a short lead sentence with no figures). Otherwise the configured provider (D-11: TBD).
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { UIBlock } from "@/lib/blocks";
import { parseUsd } from "@/lib/loan-math";
import type { Urgent } from "@/lib/blocks";
import { routeIntent, type IntentCtx, type LoanStanding } from "@/lib/intents";
import { HttpError } from "@/server/http";
import { isPowerRequest, ONLY_SUGGEST_TEXT } from "./honesty";
import type { ChatTools } from "./tools";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

const FORECAST = /\b(will|would|going to)\b[^.?!]*\b(eth|btc|bitcoin|price|market)\b[^.?!]*\b(do|go|rise|fall|moon|pump|dump|reach)\b|\b(predict|forecast|price target)\b/i;
const ADVICE = /\b(should i|is it (a good idea|worth)|good idea to)\b/i;
const EDIT = /\b(make it|change it to|change (the|my) (amount|loan|proposal)|instead|update (the|my) (amount|proposal))\b/i;
const SAFE_Q = /\b(is (this|it|that) (safe|risky|secure)|safe\?|risky\?)/i;

export type ScriptedReply = { text: string; tool?: { name: keyof ChatTools; input: Record<string, unknown> } };

const toolFor = (block: UIBlock): NonNullable<ScriptedReply["tool"]> => {
  switch (block.kind) {
    case "plan": return { name: "planLoan", input: { cash: block.cash, ...(block.asset && { asset: block.asset }), ...(block.network && { network: block.network }) } };
    case "compare": return { name: "compareLenders", input: { cash: block.cash, ...(block.asset && { asset: block.asset }), ...(block.network && { network: block.network }) } };
    case "whatif": return { name: "whatIf", input: { ...(block.asset && { asset: block.asset }), ...(block.cash !== undefined && { cash: block.cash }), ...(block.drop !== undefined && { drop: block.capped ? 100 : block.drop /* the tool re-derives `capped` from a fall above 60 */ }) } };
    case "explain": return { name: "explain", input: { topic: block.topic } };
    case "status": return { name: "showStatus", input: {} };
    case "fix": return { name: "showFix", input: { loanId: block.loanId } };
    case "holdings": return { name: "showHoldings", input: {} };
    case "addfunds": return { name: "addFunds", input: {} };
    case "suggestions": return { name: "suggest", input: { items: block.items } };
  }
};

/** What the app knows about the Safe this turn: an open loan, a proposal waiting for signatures. */
export type ChatFacts = { hasLoan?: boolean; openProposal?: boolean; standing?: LoanStanding };

/** What the scripted model says and calls for one user message. Exported for the evals. */
export function scriptedReply(text: string, maxCash: number, urgent?: Urgent, facts: ChatFacts = {}): ScriptedReply {
  if (isPowerRequest(text)) return { text: ONLY_SUGGEST_TEXT };
  const ctx: IntentCtx = { hasLoans: false, balances: { ETH: 0, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 }, maxCash: () => maxCash, urgent, hasLoan: facts.hasLoan, openProposal: facts.openProposal, standing: facts.standing };
  if (ADVICE.test(text)) return { text: "I can't tell you whether to borrow. Here is how it works.", tool: { name: "explain", input: { topic: "how" } } };
  if (FORECAST.test(text)) return { text: "I can't predict prices. Here is what a fall in price would mean for a loan.", tool: { name: "explain", input: { topic: "liquidation" } } };
  if (SAFE_Q.test(text) && !/\bsafe\b.*\b(wallet|address)\b/i.test(text)) return { text: "Here is how health and liquidation work.", tool: { name: "explain", input: { topic: "health" } } };
  const edit = EDIT.test(text) ? parseUsd(text) : null;
  if (edit !== null) return { text: facts.openProposal ? "Here is the changed plan. Sending it replaces the open proposal." : "Here is the changed plan.", tool: { name: "planEdit", input: { cash: edit } } };
  if (/\bfees?\b/i.test(text) && maxCash > 0) return { text: "The plan card shows the network fee.", tool: { name: "planLoan", input: { cash: maxCash } } };
  const intent = routeIntent(text, ctx) ?? routeIntent("hello", ctx)!;
  return { text: intent.text ?? "", tool: intent.block ? toolFor(intent.block) : undefined };
}

const lastUserText = (prompt: LanguageModelV4Prompt): string => {
  const m = [...prompt].reverse().find((p) => p.role === "user");
  return m && m.role === "user" ? m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ") : "";
};

const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

/** Stream chunks for a text-then-tool reply. Exported so tests can script their own variations. */
export function replyChunks(reply: ScriptedReply, id = "scripted"): LanguageModelV4StreamPart[] {
  const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (reply.text) chunks.push({ type: "text-start", id: `${id}-t` }, { type: "text-delta", id: `${id}-t`, delta: reply.text }, { type: "text-end", id: `${id}-t` });
  if (reply.tool) chunks.push({ type: "tool-call", toolCallId: `${id}-call`, toolName: reply.tool.name, input: JSON.stringify(reply.tool.input) });
  chunks.push({ type: "finish", usage, finishReason: { unified: reply.tool ? "tool-calls" : "stop", raw: undefined } });
  return chunks;
}

let seq = 0;
/** The scripted model. After a tool result it ends the turn without more text (the block is the answer). */
export function createScriptedModel(opts: { maxCash?: number; urgent?: Urgent; facts?: ChatFacts } = {}): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "scripted",
    doStream: async ({ prompt }) => {
      const last = prompt[prompt.length - 1];
      const reply: ScriptedReply = last?.role === "tool" ? { text: "" } : scriptedReply(lastUserText(prompt), opts.maxCash ?? 7500, opts.urgent, opts.facts);
      return { stream: simulateReadableStream({ chunks: replyChunks(reply, `s${++seq}`) }) };
    },
  });
}

/**
 * The chat model: scripted only in the mock world (`MOCK=1`; tests pass the scripted model in directly); otherwise Anthropic.
 * A real deploy without a key fails loudly instead of answering with the scripted demo.
 */
export function getChatModel(opts: { maxCash?: number; urgent?: Urgent; facts?: ChatFacts; env?: Record<string, string | undefined> } = {}): LanguageModel {
  const env = opts.env ?? process.env;
  // MOCK_LLM=anthropic keeps the mock world (fixture chain, fake Safe service) but answers with the real model, to judge chat quality.
  if (env.MOCK === "1" && !(env.MOCK_LLM === "anthropic" && env.ANTHROPIC_API_KEY)) return createScriptedModel(opts);
  const provider = env.LLM_PROVIDER ?? "anthropic";
  if (provider !== "anthropic") throw new HttpError(503, `Chat is not set up: unknown LLM_PROVIDER "${provider}".`);
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "Chat is not set up yet: the server has no model key.");
  return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.LLM_MODEL || DEFAULT_MODEL);
}
