import { statusSentence } from "@/lib/loan-copy";
import { healthStatus, maxPriceDrop, yearlyInterest } from "@/lib/loan-math";
import { levelsByLoan, levelsFor } from "@/server/levels";
import type { Levels } from "@/lib/loan-math";
import { AAVE_VENUE_NAME, unreadLenders } from "@/server/market-inputs";
import type { StatusLoan } from "@/components/blocks/StatusBlock";
import { readBlockData, type BlockCtx, type Stamp } from "./block-inputs";

export type StatusRow = StatusLoan & { /** Several assets in one lender account: health only, no liquidation price (D-05). */ mixed: boolean };
export type StatusResponse = { sentence: string; loans: StatusRow[]; maxCash: number; /** Lenders that could not be read just now: what is shown is only what was read. */ unread?: string[] } & Stamp;

/** The lender's rate and what it costs over a year on the debt read now (the loan page's figures); null when the loan is not a single USDC debt. */
const costOf = (loan: { apr: number } | null | undefined, debt: number): { apr: number | null; yearly: number | null } =>
  loan ? { apr: loan.apr, yearly: yearlyInterest(debt, loan.apr) } : { apr: null, yearly: null };

export async function statusFor(ctx: BlockCtx): Promise<StatusResponse> {
  const d = await readBlockData(ctx);
  const saved = ctx.db ? await levelsByLoan(ctx.db, ctx.safe.id) : new Map<string, Levels>();
  const loans: StatusRow[] = [];
  for (const i of d.inputs) {
    const p = i.position;
    const hasDebt = !!p && p.debt.some((x) => x.amount > 0);
    if (!p || !hasDebt || !Number.isFinite(p.healthFactor)) continue;
    const hf = p.healthFactor;
    const levels = levelsFor(saved, p.id);
    loans.push({
      ...costOf(i.loans[0], p.debt.reduce((t, x) => t + x.amount, 0)),
      id: p.id, venue: AAVE_VENUE_NAME, hf, status: healthStatus(hf, levels.warn, levels.act),
      dropPct: Math.round(maxPriceDrop(hf) * 100), mixed: p.mixed || i.unavailable !== null,
    });
  }
  // The other lenders' loans too (Morpho, Compound v3): the same live read the sidebar and the loans route use.
  for (const i of d.inputs) {
    for (const f of i.lenders) {
      const p = f.position;
      if (!p || !p.debt.some((x) => x.amount > 0) || p.health === null || !Number.isFinite(p.health)) continue;
      const id = `${i.chainId}:${p.safe.toLowerCase()}:${f.id}`;
      const levels = levelsFor(saved, id);
      loans.push({
        ...costOf(f.loan, p.debt.reduce((t, x) => t + x.amount, 0)),
        id, venue: f.name, hf: p.health, status: healthStatus(p.health, levels.warn, levels.act),
        dropPct: Math.round(maxPriceDrop(p.health) * 100), mixed: p.mixed || f.unavailable,
      });
    }
  }
  const worst = loans.reduce<StatusRow | undefined>((w, r) => (!w || r.hf < w.hf ? r : w), undefined);
  const unread = unreadLenders(d.inputs);
  const couldnt = `Couldn't read ${unread.join(" and ")} just now.`;
  const known = statusSentence(loans.map((l) => l.status), worst?.venue);
  // Never "fine" while a lender is unread: only what was read is said.
  const sentence = !unread.length ? known : loans.every((l) => l.status === "healthy") ? couldnt : `${known} ${couldnt}`;
  return { sentence, ...(unread.length ? { unread } : {}), loans, maxCash: d.max, blockNumber: d.blockNumber, readAt: d.readAt };
}
