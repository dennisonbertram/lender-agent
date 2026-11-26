// How much the executor asks the role for. The sizing math is `reservePlan` (loan-math), repay only (D-01): the
// reserve's collateral balance is 0, and the daily cap is the allowance left on-chain. The amount REQUESTED is what
// the allowance is charged (M0-6): a partial repay requests exactly what it repays; a full repay requests the debt
// plus a small buffer, never `type(uint256).max`, which the role rejects.
import { reservePlan } from "@/lib/loan-math";

export type ExecPlan = {
  /** Stablecoin the reserve will repay, in token units (what the plan gives within the allowance and balance). */
  use: number;
  /** What the loan needs to reach the target, ignoring the reserve's limits. */
  need: number;
  /** Need that the reserve cannot cover now. */
  rest: number;
  /** The amount to request from the role, raw units; 0 means do not call. */
  requestRaw: bigint;
  hfBefore: number;
  /** Health after repaying `use`, estimated from the position (the real value is read after the receipt). */
  hfAfter: number;
  target: number;
  /** The allowance (or balance) is what stopped the plan short of the target. */
  capReached: boolean;
  full: boolean;
};

const BUFFER_PCT = 0.001;
const BUFFER_ABS = 0.01;

export function planReserveRepay(i: {
  collateralUsd: number; lt: number; debt: number; trigger: number; target: number;
  balance: number; allowanceLeft: number; decimals: number; allowanceLeftRaw: bigint;
}): ExecPlan | null {
  const loan = { amount: 1, price: i.collateralUsd, lt: i.lt, debt: i.debt };
  const unlimited = reservePlan(loan, i.target, { coll: 0, stable: Infinity }, { armed: true, emergencyHF: i.trigger, dailyCapUsd: Infinity, usedUsd24h: 0 });
  if (!unlimited) return null;
  const limited = reservePlan(loan, i.target, { coll: 0, stable: i.balance }, { armed: true, emergencyHF: i.trigger, dailyCapUsd: i.allowanceLeft, usedUsd24h: 0 });
  const scale = 10 ** i.decimals;
  const use = limited ? Math.floor(limited.repay * scale) / scale : 0;
  const full = use > 0 && use >= i.debt - 1 / scale;
  let requestRaw = BigInt(Math.floor(use * scale));
  if (full) {
    const withBuffer = BigInt(Math.ceil((i.debt * (1 + BUFFER_PCT) + BUFFER_ABS) * scale));
    requestRaw = withBuffer < i.allowanceLeftRaw ? withBuffer : i.allowanceLeftRaw;
    if (requestRaw < BigInt(Math.floor(use * scale))) requestRaw = BigInt(Math.floor(use * scale));
  }
  const hfAfter = i.debt - use > 1e-9 ? (i.collateralUsd * i.lt) / (i.debt - use) : Infinity;
  const capReached = hfAfter < i.target - 1e-6;
  return { use, need: unlimited.repay, rest: Math.max(0, unlimited.repay - use), requestRaw, hfBefore: unlimited.hfBefore, hfAfter, target: i.target, capReached, full };
}
