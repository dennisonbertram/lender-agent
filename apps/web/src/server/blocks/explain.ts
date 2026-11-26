// Reviewed explain copy per topic (mockup wording is final). The ported ExplainBlock renders the
// text itself from `topic` and `needs`; this adds the figures it needs and the per-lender
// liquidation sentence (architecture 9.4: Aave v3 sells only part of the collateral).
import { type Levels } from "@/lib/loan-math";
import type { UIBlock } from "@/lib/blocks";
import { AAVE_VENUE_NAME } from "@/server/market-inputs";
import { levelsByLoan, levelsFor } from "@/server/levels";
import { readBlockData, type BlockCtx, type Stamp } from "./block-inputs";

export type ExplainTopic = Extract<UIBlock, { kind: "explain" }>["topic"];
export const EXPLAIN_TOPICS: ExplainTopic[] = ["how", "health", "liquidation", "collateral", "safe", "reserve"];

/** Per-lender liquidation sentence. Add a lender here when it is offered (Compound v3 takes the whole account). */
const LIQUIDATION_BY_LENDER: Record<string, string> = {
  [AAVE_VENUE_NAME]: `${AAVE_VENUE_NAME} can sell only part of your collateral, enough to repay part of the loan. You keep the rest.`,
};

export const liquidationSentence = (lender: string | undefined): string | null => (lender ? LIQUIDATION_BY_LENDER[lender] ?? null : null);

export type ExplainResponse = {
  topic: ExplainTopic;
  /** Signatures the Safe needs. */
  needs: number;
  levels: Levels;
  maxCash: number;
  lender: string | null;
  /** Shown under the topic text for `how` and `liquidation`; null when no lender is known. */
  lenderLine: string | null;
} & Stamp;

export async function explainFor(ctx: BlockCtx, topic: ExplainTopic): Promise<ExplainResponse> {
  const d = await readBlockData(ctx);
  // The lender the owner has a loan with, else the one a plan would use (the borrow limit's), not always Aave.
  const held = d.primary.position && d.primary.loans[0] ? AAVE_VENUE_NAME : d.primary.lenders.find((f) => f.position?.debt.some((x) => x.amount > 0))?.name;
  const lender = held ?? (d.primary.position ? AAVE_VENUE_NAME : d.limit.lenderName ?? d.primary.venues[0]?.name ?? null);
  const lenderLine = topic === "how" || topic === "liquidation" ? liquidationSentence(lender ?? undefined) : null;
  const saved = ctx.db ? await levelsByLoan(ctx.db, ctx.safe.id) : new Map<string, Levels>();
  const levels = levelsFor(saved, d.primary.position?.id ?? "");
  return { topic, needs: d.threshold, levels, maxCash: d.max, lender, lenderLine, blockNumber: d.blockNumber, readAt: d.readAt };
}
