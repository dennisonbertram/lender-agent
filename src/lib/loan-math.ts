export type HealthStatus = "healthy" | "watch" | "risk" | "liquidatable";

export const statusLabel: Record<HealthStatus, string> = { healthy: "Healthy", watch: "Watch", risk: "At risk", liquidatable: "Can be liquidated" };

/** Health factor = sum(collateral value x liquidation threshold) / debt value. */
export const healthFactor = (collateralValue: number, lt: number, debt: number) =>
  debt <= 0 ? Infinity : (collateralValue * lt) / debt;

/** Collateral price at which the health factor reaches 1.0. */
export const liquidationPrice = (amount: number, lt: number, debt: number) =>
  amount <= 0 ? 0 : debt / (amount * lt);

/** Health factor after the collateral price falls by `drop` (0..1); debt is a stablecoin. */
export const hfAfterDrop = (hf: number, drop: number) => hf * (1 - drop);

export const yearlyInterest = (debt: number, aprPct: number) => (debt * aprPct) / 100;

export const healthStatus = (hf: number, warn: number, act: number): HealthStatus =>
  hf < 1 ? "liquidatable" : hf >= warn ? "healthy" : hf >= act ? "watch" : "risk";

/** Loans that need attention: the at-risk (or worse) loans if any, otherwise the watch loans.
 *  `risk` counts at-risk loans; `worst` has the lowest health factor among the counted loans. */
export function attentionOf<T extends { hf: number; status: HealthStatus }>(loans: T[]): { risk: number; count: number; worst?: T } {
  const risky = loans.filter((l) => l.status === "risk" || l.status === "liquidatable");
  const pool = risky.length ? risky : loans.filter((l) => l.status === "watch");
  return { risk: risky.length, count: pool.length, worst: pool.reduce<T | undefined>((w, l) => (!w || l.hf < w.hf ? l : w), undefined) };
}

/** Collateral units to add so the loan reaches `target` health factor. */
export const collateralNeeded = (amount: number, price: number, lt: number, debt: number, target: number) =>
  Math.max(0, (debt * target) / lt / price - amount);

/** Stablecoin to repay so the loan reaches `target` health factor. */
export const repayNeeded = (collateralValue: number, lt: number, debt: number, target: number) =>
  Math.max(0, debt - (collateralValue * lt) / target);

export type ReservePolicy = { armed: boolean; emergencyHF: number; dailyCapUsd: number; usedUsd24h: number; usedSince?: number };
export type ReservePlan = { supply: number; repay: number; usd: number; hfBefore: number; hfAfter: number; unmet: boolean };

/**
 * What the agent may do from the Reserve Safe for one loan: supply its own collateral first, then repay
 * with the debt stablecoin, both limited by reserve balances and the remaining 24h cap (stablecoin = $1).
 * Returns null when it must do nothing: paused, nothing needed, above the trigger (unless `force`), or no cap left.
 */
export function reservePlan(
  loan: { amount: number; price: number; lt: number; debt: number },
  target: number,
  bal: { coll: number; stable: number },
  policy: ReservePolicy,
  force = false,
): ReservePlan | null {
  const hfBefore = healthFactor(loan.amount * loan.price, loan.lt, loan.debt);
  if (!policy.armed || (!force && hfBefore >= policy.emergencyHF) || hfBefore >= target) return null;
  const capLeft = Math.max(0, policy.dailyCapUsd - policy.usedUsd24h);
  const need = collateralNeeded(loan.amount, loan.price, loan.lt, loan.debt, target);
  const supply = Math.min(need, bal.coll, capLeft / loan.price);
  const value = (loan.amount + supply) * loan.price;
  const repay = Math.min(repayNeeded(value, loan.lt, loan.debt, target), bal.stable, capLeft - supply * loan.price);
  if (supply + repay < 1e-9) return null;
  const hfAfter = healthFactor(value, loan.lt, loan.debt - repay);
  return { supply, repay, usd: supply * loan.price + repay, hfBefore, hfAfter, unmet: hfAfter < target - 1e-6 };
}

/** Default alert levels for a loan with no saved thresholds. */
export type Levels = { warn: number; act: number };
export const DEFAULT_LEVELS: Levels = { warn: 1.6, act: 1.35 };
export const levelsOf = (t: Record<string, Levels>, id: string): Levels => t[id] ?? DEFAULT_LEVELS;

/** A plain number in free text: "1,8" is 1.8, "$15,000" is 15000. Null for empty text, units, exponents and signs. */
export function parseNumber(text: string): number | null {
  let t = text.replace(/[$\s]/g, "");
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  return /^(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : null;
}

/** A message per invalid level; empty when both are valid (1 < act < warn <= 5). */
export function levelErrors(warn: string, act: string): { warn?: string; act?: string } {
  const out: { warn?: string; act?: string } = {};
  const n: Record<"warn" | "act", number | null> = { warn: null, act: null };
  for (const [k, text, name] of [["warn", warn, "Watch level"], ["act", act, "At-risk level"]] as const) {
    const v = parseNumber(text);
    n[k] = v;
    if (!text.trim()) out[k] = `Enter ${name}.`;
    else if (v === null) out[k] = "Use numbers only, for example 1.6.";
    else if (v > 5) out[k] = `${name} can be at most 5.0.`;
    else if (v <= 1) out[k] = `${name} must be above 1.0.`;
  }
  if (!out.warn && !out.act && n.act! >= n.warn!) out.act = "At-risk level must be below Watch level.";
  return out;
}

/** Levels typed by the user, or null unless both are valid (see levelErrors). */
export function parseLevels(warn: string, act: string): Levels | null {
  const w = parseNumber(warn);
  const a = parseNumber(act);
  return w === null || a === null || Object.keys(levelErrors(warn, act)).length ? null : { warn: w, act: a };
}
/** Smallest loan the explorer offers, and the slider step. */
export const MIN_LOAN = 500;

/** Largest loan, in MIN_LOAN steps, with health >= minHf and within the venue's max LTV. 0 when none. */
export const maxSafeBorrow = (value: number, lt: number, maxLtv: number, minHf: number) =>
  Math.max(0, Math.floor(Math.min(value * maxLtv, (value * lt) / minHf) / MIN_LOAN) * MIN_LOAN);

/** Share of the collateral price that can be lost before liquidation (0..1). */
export const maxPriceDrop = (hf: number) => (!Number.isFinite(hf) ? 1 : hf <= 1 ? 0 : 1 - 1 / hf);

/** Amount typed by the user, clamped to 0..balance. `over` is true when the text asked for more than the balance. */
export function parseAmount(text: string, balance: number): { amount: number; over: boolean } {
  const n = parseNumber(text);
  if (n === null) return { amount: 0, over: false };
  return n > balance ? { amount: balance, over: true } : { amount: n, over: false };
}

/** A dollar amount in free text: "$10k", "12.5k", "$15,000", "15000". Bare numbers under 1000 with no $ or k are ignored. */
export function parseUsd(text: string): number | null {
  for (const m of text.matchAll(/(\$)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?(?![a-z])/gi)) {
    const n = Number(m[2].replace(/,/g, "")) * (m[3] ? 1000 : 1);
    if (Number.isFinite(n) && n > 0 && (m[1] || m[3] || n >= 1000)) return n;
  }
  return null;
}
