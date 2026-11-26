// The chat tool registry (architecture section 6). Each tool returns exactly one block and parses
// its own result with the block schema. No tool drafts, queues or signs anything (rules 4 and 5);
// later stories add tools here.
import { tool } from "ai";
import { z } from "zod";
import type { PlanRefusal, UIBlock } from "@/lib/blocks";
import type { Asset, Network } from "@/lib/types";
import { MAX_DROP, nearestDropStep } from "@/lib/whatif-drop";
import { blockSchema, parseBlock } from "./block-schema";
import { safeChips } from "./honesty";

const asset = z.enum(["ETH", "wstETH", "WBTC"]);
const network = z.enum(["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"]);

/** What the model reads back from a plan tool: a refusal says so plainly, so its text cannot claim a plan exists. */
const planModelOutput = ({ output }: { output: UIBlock }) =>
  ({ type: "json" as const, value: output.kind === "plan" && output.refusal ? { ok: false, reason: output.refusal.reason, needUsd: output.refusal.needUsd } : { ok: true } });

/** What a plan check answers: whether the Safe can back at least the smallest loan (a refusal when not), and the network it checked — stamped on the plan block when the tool named none, so quote, send and sign all use the network the owner saw. */
export type PlanCheckResult = { refusal: PlanRefusal | null; network?: Network };
/** Decides, before a plan card is drawn, whether the Safe can back at least the smallest loan. Null when the question cannot be answered (an unserved network). */
export type PlanCheck = (cash: number, want: { asset?: Asset; network?: Network; edit?: boolean }) => PlanCheckResult | null | Promise<PlanCheckResult | null>;

export const chatTools = {
  planLoan: tool({
    description: "Show a loan plan the owner can adjust. Pass only the parameters; the card fetches the live figures. Never write amounts, rates or prices in text.",
    inputSchema: z.object({ cash: z.number().nonnegative().describe("Cash the owner wants, in dollars"), asset: asset.optional(), network: network.optional(), hypothetical: z.boolean().optional().describe("true for a sizing question (\"how much collateral would I need for 100k?\"): shows the collateral that amount needs, not capped to what the Safe can borrow, and cannot be sent") }),
    outputSchema: blockSchema,
    toModelOutput: planModelOutput,
    execute: async ({ cash, asset, network, hypothetical }): Promise<UIBlock> => parseBlock({ kind: "plan", cash, ...(hypothetical && { hypothetical }), ...(asset && { asset }), ...(network && { network }) }),
  }),
  planEdit: tool({
    description: "Change the amount of the loan proposal that is already open, for \"make it $3,000 instead\" or \"lower it\". Shows a new plan card; Send replaces the open proposal. Pass only the parameters; the card fetches the live figures. Never write amounts, rates or prices in text.",
    inputSchema: z.object({ cash: z.number().nonnegative().describe("The new cash amount the owner wants, in dollars"), asset: asset.optional(), network: network.optional() }),
    outputSchema: blockSchema,
    toModelOutput: planModelOutput,
    execute: async ({ cash, asset, network }): Promise<UIBlock> => parseBlock({ kind: "plan", cash, edit: true, ...(asset && { asset }), ...(network && { network }) }),
  }),
  compareLenders: tool({
    description: "Show the lenders side by side for an amount: rate, about what it costs a year, how far the price can fall. Use for comparing lenders, rates and offers, and for \"why is a lender cheaper\". Pass only the parameters; the block fetches the figures. Never write them in text.",
    inputSchema: z.object({ cash: z.number().nonnegative().describe("Cash the owner wants, in dollars"), asset: asset.optional(), network: network.optional() }),
    outputSchema: blockSchema,
    execute: async ({ cash, asset, network }): Promise<UIBlock> => parseBlock({ kind: "compare", cash, ...(asset && { asset }), ...(network && { network }) }),
  }),
  whatIf: tool({
    description: "Show what a fall in the collateral price would do to each loan, with a slider. Use for \"what if ETH drops\" questions. Never write prices or percentages in text.",
    inputSchema: z.object({ asset: asset.optional(), cash: z.number().nonnegative().optional().describe("Loan size to imagine when the Safe has no loan, in dollars"), drop: z.number().int().min(0).max(100).optional().describe("The fall the user asked for, percent (\"falls 30%\" is 30); leave out when none was named") }),
    outputSchema: blockSchema,
    execute: async ({ asset, cash, drop }): Promise<UIBlock> => parseBlock({ kind: "whatif", ...(asset && { asset }), ...(cash !== undefined && { cash }), ...(drop !== undefined && { drop: nearestDropStep(drop), ...(drop > MAX_DROP && { capped: true }) }) }),
  }),
  explain: tool({
    description: "Show the reviewed explanation of one topic. Use for how it works, health factor, liquidation, collateral, what a Safe is, or the reserve.",
    inputSchema: z.object({ topic: z.enum(["how", "health", "liquidation", "collateral", "safe", "reserve"]) }),
    outputSchema: blockSchema,
    execute: async ({ topic }): Promise<UIBlock> => parseBlock({ kind: "explain", topic }),
  }),
  showStatus: tool({
    description: "Show where the owner stands: the loans in this Safe and their health. Use for any question whose answer is a current figure about their loans.",
    inputSchema: z.object({}),
    outputSchema: blockSchema,
    execute: async (): Promise<UIBlock> => parseBlock({ kind: "status" }),
  }),
  showFix: tool({
    description: "Show the fix options for one at-risk loan. Use when the owner asks to fix or protect a loan that needs attention. Never a new borrowing plan.",
    inputSchema: z.object({ loanId: z.string().min(1) }),
    outputSchema: blockSchema,
    execute: async ({ loanId }): Promise<UIBlock> => parseBlock({ kind: "fix", loanId }),
  }),
  showHoldings: tool({
    description: "Show what the Safe holds and how much could be borrowed against each asset. Use for rates, fees, prices or amounts the owner asks about.",
    inputSchema: z.object({}),
    outputSchema: blockSchema,
    execute: async (): Promise<UIBlock> => parseBlock({ kind: "holdings" }),
  }),
  addFunds: tool({
    description: "Show the address to send crypto to, when the Safe needs funds.",
    inputSchema: z.object({}),
    outputSchema: blockSchema,
    execute: async (): Promise<UIBlock> => parseBlock({ kind: "addfunds" }),
  }),
  suggest: tool({
    description: "Offer short follow-up chips the owner can tap. Chips are things the owner could say, with no figures.",
    inputSchema: z.object({ items: z.array(z.string().min(1)).min(1).max(6) }),
    outputSchema: blockSchema.nullable(),
    execute: async ({ items }): Promise<UIBlock | null> => {
      const safe = safeChips(items); // a chip with a figure is dropped; none left means no block, not an error
      return safe.length ? parseBlock({ kind: "suggestions", items: safe }) : null;
    },
  }),
};

export type ChatTools = typeof chatTools;

/** The tools of one turn: the plan tools refuse up front (a plan block with `refusal`) when the Safe cannot back the loan. */
export function chatToolsFor(check?: PlanCheck): ChatTools {
  if (!check) return chatTools;
  const guarded = <T extends ChatTools["planLoan"]>(t: T, edit: boolean): T => ({
    ...t,
    execute: async ({ cash, asset, network, hypothetical }: { cash: number; asset?: Asset; network?: Network; hypothetical?: boolean }): Promise<UIBlock> => {
      if (hypothetical && !edit) return parseBlock({ kind: "plan", cash, hypothetical: true, ...(asset && { asset }), ...(network && { network }) }); // a size question: no refusal for what the Safe holds
      const r = await check(cash, { asset, network, edit });
      const source = network ?? r?.network;
      return parseBlock({ kind: "plan", cash, ...(edit && { edit: true }), ...(asset && { asset }), ...(source && { network: source }), ...(r?.refusal && { refusal: r.refusal }) });
    },
  }) as T;
  return { ...chatTools, planLoan: guarded(chatTools.planLoan, false), planEdit: guarded(chatTools.planEdit, true) };
}
/** Tool name that produces each block kind (the client and the fallback map blocks back to tools). */
export const TOOL_OF_KIND: Partial<Record<UIBlock["kind"], keyof ChatTools>> = {
  plan: "planLoan", compare: "compareLenders", whatif: "whatIf", explain: "explain", status: "showStatus", fix: "showFix", holdings: "showHoldings", addfunds: "addFunds", suggestions: "suggest",
};
/** Tools that read the Safe's real data when their block renders (one Activity row per reply). */
export const READ_TOOLS: ReadonlySet<string> = new Set(["showStatus", "showHoldings"]);
