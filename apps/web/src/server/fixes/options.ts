// Fix options for an at-risk loan on any allowed lender (BP-22): add collateral from the Safe, repay part with USDC in the
// Safe, or half of each. Every figure comes from the app's math (`alertAmounts`, `alertOptions`) applied to
// the lender's own position, prices and the Safe's balances at one read (G1). Nothing here is the model's.
import { desc, and, eq } from "drizzle-orm";
import { alertAmounts, alertOptions, optionsNote, type AlertOption } from "@/lib/alerts";
import { DEFAULT_LEVELS, fixTargetHf, type Levels } from "@/lib/loan-math";
import { snapshots } from "@/server/db/schema";
import type { Db } from "@/server/db/client";
import { loansOf } from "@/server/quote";
import type { LenderId } from "@/server/lenders/types";
import { levelsByLoan } from "@/server/levels";
import { AAVE_VENUE_ID, liveInputs, type LiveInputs } from "@/server/market-inputs";
import type { Services } from "@/server/services";
import type { Address, ChainId } from "@/shared/types";
import type { Loan, PriceMap } from "@/lib/types";

export type FixDeps = { db: Db; services: Pick<Services, "reader" | "lenders"> };
export type FixSafe = { id: number; address: string };

export type FixOptions = {
  loanId: string;
  chainId: ChainId;
  lender: string;
  collAsset: string;
  /** The lender's health factor now. */
  healthFactor: number;
  levels: Levels;
  /** Health is below the loan's At-risk level. */
  atRisk: boolean;
  /** At risk: the fix is proposed at the Safe's current nonce (D-10). */
  urgent: boolean;
  /** Usable options first (the recommended one on top), greyed ones last (r15). */
  options: AlertOption[];
  /** One line under the options ("" when none is usable). */
  note: string;
  blockNumber: number;
};

export const chainIdOfLoan = (loanId: string): number => Number(loanId.split(":")[0]);

/** The loan's Watch and At-risk levels: its saved row, else the defaults. */
export async function levelsOfLoan(db: Db, safeId: number, loanId: string): Promise<Levels> {
  return (await levelsByLoan(db, safeId)).get(loanId.toLowerCase()) ?? DEFAULT_LEVELS;
}

/** Whether the monitor's latest stored snapshot of the loan is below its At-risk level (no chain read). */
export async function monitorAtRisk(db: Db, safeId: number, loanId: string): Promise<boolean> {
  const [snap] = await db.select({ health: snapshots.health }).from(snapshots)
    .where(and(eq(snapshots.safeId, safeId), eq(snapshots.loanId, loanId))).orderBy(desc(snapshots.at), desc(snapshots.id)).limit(1);
  if (!snap) return false;
  const hf = Number(snap.health);
  return Number.isFinite(hf) && hf < (await levelsOfLoan(db, safeId, loanId)).act;
}

export type LiveLoan = { loan: Loan; inputs: LiveInputs; hf: number; lender: LenderId; /** The lender's own prices over the shared ones (D-07). */ prices: PriceMap; loans: Loan[] };

/** The loan and its inputs from one live read, through the lender that holds it (`chain:safe:lender`); null when the Safe has no such loan (or it is not one the product plans on). */
export async function liveLoan(deps: FixDeps, safe: FixSafe, loanId: string): Promise<LiveLoan | null> {
  const chainId = chainIdOfLoan(loanId);
  if (chainId !== 8453 && chainId !== 84532) return null;
  const lender = (loanId.split(":")[2] ?? AAVE_VENUE_ID) as LenderId;
  const inputs = await liveInputs(deps.services.reader, chainId, safe.address as Address, deps.services.lenders);
  const facts = inputs.lenders.find((f) => f.id === lender);
  const loan = facts?.loan && facts.loan.id.toLowerCase() === loanId.toLowerCase() ? facts.loan : undefined;
  const hf = lender === AAVE_VENUE_ID ? inputs.position?.healthFactor : facts?.position?.health ?? undefined;
  if (!facts || !loan || loan.debt <= 0 || hf === undefined || hf === null || !Number.isFinite(hf)) return null;
  return { loan, inputs, hf, lender, prices: { ...inputs.prices, ...facts.prices }, loans: loansOf(inputs) };
}

/** The fix options for one loan, from live data. Null when the Safe has no such loan with debt. */
export async function fixOptionsFor(safe: FixSafe, loan: { id: string; chainId?: ChainId }, deps: FixDeps): Promise<FixOptions | null> {
  const live = await liveLoan(deps, safe, loan.id);
  if (!live) return null;
  const { loan: l, inputs, hf } = live;
  const levels = await levelsOfLoan(deps.db, safe.id, loan.id);
  const price = live.prices[l.collAsset];
  const a = alertAmounts(l, price, fixTargetHf(levels));
  // Repaying more than is owed repays the debt only; the offer never exceeds it.
  const amounts = { addColl: a.addColl, repay: Math.min(a.repay, Math.ceil(l.debt)) };
  const options = alertOptions({ snap: l, price, ...amounts }, inputs.balances);
  const atRisk = hf < levels.act;
  return {
    loanId: l.id, chainId: inputs.chainId, lender: l.venue, collAsset: l.collAsset, healthFactor: hf, levels, atRisk, urgent: atRisk,
    options, note: optionsNote(options, l.collAsset), blockNumber: Number(inputs.blockNumber),
  };
}
