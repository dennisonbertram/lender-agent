import { fmt, usd } from "@/data";
import { healthFactor, reservePlan, type ReservePlan, type ReservePolicy } from "./loan-math";

export type ReserveBlock = "paused" | "notNeeded" | "capUsed" | "noBalance";
type LoanIn = { amount: number; price: number; lt: number; debt: number };

/** Why the reserve cannot act on this loan, or null when a forced plan exists. Checked in this order. */
export function reserveBlock(loan: LoanIn, target: number, bal: { coll: number; stable: number }, policy: ReservePolicy): ReserveBlock | null {
  if (!policy.armed) return "paused";
  if (healthFactor(loan.amount * loan.price, loan.lt, loan.debt) >= target) return "notNeeded";
  if (policy.dailyCapUsd - policy.usedUsd24h <= 0) return "capUsed";
  if ((bal.coll <= 0 && bal.stable <= 0) || !reservePlan(loan, target, bal, policy, true)) return "noBalance";
  return null;
}

export type ReserveStatusKind = "armed" | "limitReached" | "paused";
export type ReserveStatus = { kind: ReserveStatusKind; label: string; tone: "success" | "warning" | "muted"; banner: string };

/** The one status every surface shows. "Not linked" is not a kind: each surface already hides the status then. */
export function reserveStatus(policy: ReservePolicy, now: number): ReserveStatus {
  if (!policy.armed) return { kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." };
  if (policy.dailyCapUsd - policy.usedUsd24h <= 0) {
    const reset = capResetLabel(policy.usedSince, now);
    return { kind: "limitReached", label: "Limit reached", tone: "warning", banner: `Limit reached: today's ${usd(policy.dailyCapUsd)} is used. ${reset ? `${reset}. ` : ""}The agent only suggests until then.` };
  }
  return { kind: "armed", label: "On", tone: "success", banner: "On: the agent can act on its own within these limits, without your signature." };
}

/** "5.00 ETH + 1,275 DAI ($15,000)"; one asset only when the other is 0. */
export function reservePreview(plan: ReservePlan, collAsset: string, debtAsset: string): string {
  const parts = [plan.supply > 0 && `${fmt(plan.supply, 2)} ${collAsset}`, plan.repay > 0 && `${fmt(plan.repay)} ${debtAsset}`].filter(Boolean);
  return `${parts.join(" + ")} (${usd(plan.usd)})`;
}

/**
 * "Resets in 23 h" from the first use of today's limit. Computed at render time; no timers.
 * ponytail: mockup never rolls the limit over; a demo session never lasts 24 h.
 */
export function capResetLabel(usedSince: number | undefined, now: number): string | null {
  if (usedSince === undefined) return null;
  const left = usedSince + 24 * 3600_000 - now;
  return left <= 0 ? "Resets soon" : `Resets in ${Math.min(24, Math.ceil(left / 3600_000))} h`;
}

/** Short button subtitle for a block. */
export function blockLabel(block: ReserveBlock, c: { hf: number; target: number; coll: string; debt: string; reset: string | null }): string {
  switch (block) {
    case "paused": return "Reserve off";
    case "notNeeded": return `Not needed: health is ${c.hf.toFixed(2)}`;
    case "capUsed": return c.reset ? `Today's limit is used · ${c.reset}` : "Today's limit is used";
    case "noBalance": return `Reserve has no ${c.coll} or ${c.debt}`;
  }
}

/** Full chat sentence for a block. `pick` is where the other fixes are, relative to the message. */
export function blockMessage(block: ReserveBlock, c: { cap: number; used: number; coll: string; debt: string; reset: string | null; hf?: number; pick?: "above" | "below" }): string {
  const next = c.pick === "above" ? "Pick another option above and sign it in Safe." : "Pick a fix below and sign it in Safe.";
  switch (block) {
    case "paused": return "The reserve is off, so I can only suggest.";
    case "notNeeded": return `This loan is already at health ${(c.hf ?? 0).toFixed(2)}. The reserve was not used.`;
    case "capUsed": return `Today's reserve limit is used (${usd(c.used)} of ${usd(c.cap)}). ${c.reset ? `${c.reset}. ` : ""}${next}`;
    case "noBalance": return `The reserve has no ${c.coll} or ${c.debt} for this loan. ${next}`;
  }
}

/** Note under the reserve card when the plan did not reach the target. */
export const unmetNote = (capReached: boolean, draftHf: number) =>
  `${capReached ? "The daily limit is reached." : "The reserve ran out."} I drafted the rest below (health ${draftHf.toFixed(2)} after you sign).`;
