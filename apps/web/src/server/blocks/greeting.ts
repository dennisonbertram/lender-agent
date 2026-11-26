import { limitWhy } from "@/lib/borrow-limit";
import { greetingText, starterChips, type Urgent } from "@/lib/blocks";
import type { LoanStanding } from "@/lib/intents";
import { DEFAULT_LEVELS, healthStatus, MIN_LOAN, type HealthStatus } from "@/lib/loan-math";
import { levelsByLoan, levelsFor } from "@/server/levels";
import { AAVE_VENUE_NAME, borrowLimit, unreadLenders } from "@/server/market-inputs";
import { HttpError } from "@/server/http";
import { SAFETY_TITLES } from "./get-cash";
import { readBlockData, servedOwned, type BlockCtx, type BlockData, type Stamp } from "./block-inputs";

export type GreetingBlock = { text: string; chips: string[]; max: number; /** The lender that gives the limit: a chat plan defaults to it. */ lenderId: string | null; /** The asset that limit is against: the default lender only suits a plan for this asset. */ lenderAsset: string | null; /** "Why $X? ..." (empty with no limit). */ why: string } & Stamp;

/** The first loan that is At risk or liquidatable (judged by the owner's saved levels, like the loan views), or undefined. */
export async function urgentLoanOf(d: BlockData, ctx: Pick<BlockCtx, "db" | "safe">): Promise<Urgent | undefined> {
  const saved = ctx.db ? await levelsByLoan(ctx.db, ctx.safe.id) : undefined;
  for (const i of d.inputs) {
    const p = i.position;
    if (!p || !p.debt.some((x) => x.amount > 0) || !Number.isFinite(p.healthFactor)) continue;
    const l = saved ? levelsFor(saved, p.id) : DEFAULT_LEVELS;
    const s = healthStatus(p.healthFactor, l.warn, l.act);
    if (s === "risk" || s === "liquidatable") return { lender: AAVE_VENUE_NAME, loanId: p.id };
  }
  // The other lenders' loans too (a plan from the borrow limit opens Morpho or Compound, not Aave).
  for (const i of d.inputs) {
    for (const f of i.lenders) {
      const p = f.position;
      if (!p || !p.debt.some((x) => x.amount > 0) || p.health === null || !Number.isFinite(p.health)) continue;
      const loanId = `${i.chainId}:${p.safe.toLowerCase()}:${f.id}`;
      const l = saved ? levelsFor(saved, loanId) : DEFAULT_LEVELS;
      const s = healthStatus(p.health, l.warn, l.act);
      if (p.liquidatable || s === "risk" || s === "liquidatable") return { lender: f.name, loanId };
    }
  }
  return undefined;
}

/** Every open loan's status, the worst one named: healthy only when each loan is affirmatively healthy; "unknown" when there is none to judge. */
export async function loanStandingOf(d: BlockData, ctx: Pick<BlockCtx, "db" | "safe">): Promise<LoanStanding & { unreadable?: string[] }> {
  const unread = unreadLenders(d.inputs);
  const st = await standingOf(d, ctx);
  if (!unread.length) return st;
  // A lender could not be read: never "healthy" (a loan there is unknown); a worse known status still stands.
  return { ...(st.status === "healthy" ? { status: "unknown" as const } : st), unreadable: unread };
}

async function standingOf(d: BlockData, ctx: Pick<BlockCtx, "db" | "safe">): Promise<LoanStanding> {
  const saved = ctx.db ? await levelsByLoan(ctx.db, ctx.safe.id) : undefined;
  const found: { status: HealthStatus; health: number; loanId: string }[] = [];
  for (const i of d.inputs) {
    const p = i.position;
    if (p && p.debt.some((x) => x.amount > 0)) {
      if (!Number.isFinite(p.healthFactor)) return { status: "unknown" };
      const l = saved ? levelsFor(saved, p.id) : DEFAULT_LEVELS;
      found.push({ status: healthStatus(p.healthFactor, l.warn, l.act), health: p.healthFactor, loanId: p.id });
    }
    for (const f of i.lenders) {
      const p2 = f.position;
      if (!p2 || !p2.debt.some((x) => x.amount > 0)) continue;
      if (p2.health === null || !Number.isFinite(p2.health)) return { status: "unknown" };
      const loanId = `${i.chainId}:${p2.safe.toLowerCase()}:${f.id}`;
      const l = saved ? levelsFor(saved, loanId) : DEFAULT_LEVELS;
      found.push({ status: p2.liquidatable ? "liquidatable" : healthStatus(p2.health, l.warn, l.act), health: p2.health, loanId });
    }
  }
  if (!found.length) return { status: "unknown" };
  const order: HealthStatus[] = ["healthy", "watch", "risk", "liquidatable"];
  const worst = found.reduce((a, b) => (order.indexOf(b.status) > order.indexOf(a.status) ? b : a));
  return { status: worst.status, health: worst.health, loanId: worst.loanId };
}

export async function greetingFor(ctx: BlockCtx): Promise<GreetingBlock> {
  const d = await readBlockData(ctx);
  const urgent = await urgentLoanOf(d, ctx);
  const order = servedOwned(ctx);
  const sources = order.flatMap((chainId) => d.inputs.filter((input) => input.chainId === chainId));
  const source = sources.find((input) => borrowLimit(input).max >= MIN_LOAN) ?? sources[0] ?? d.primary;
  const limit = borrowLimit(source);
  if (limit.max < MIN_LOAN && !urgent && ctx.access.unreadChainIds?.length) throw new HttpError(503, "Could not confirm balances on every network.");
  const hasAssets = d.inputs.some((input) => input.weth > 0 || Object.values(input.balances).some((amount) => amount > 0));
  return { text: greetingText(d.name, d.threshold, limit.max, urgent, hasAssets), chips: starterChips(limit.max, urgent), max: limit.max, lenderId: limit.lenderId, lenderAsset: limit.asset, why: limitWhy(limit, SAFETY_TITLES[1]), blockNumber: d.blockNumber, readAt: d.readAt };
}
