import { fmt, usd } from "@/lib/format";
import type { Asset, Network } from "@/lib/types";
import { MIN_LOAN } from "@/lib/loan-math";

/** Why a plan was refused before it was drawn. `needUsd` is about how much more collateral, in dollars, the loan needs. */
export type PlanRefusal = { reason: "not_enough_collateral"; needUsd: number };

/** A generated UI block the agent can post in the chat. In phase 2 each is the typed result of an LLM tool call. */
export type UIBlock =
  | { kind: "plan"; cash: number; asset?: Asset; network?: Network; venueId?: string; hfIdx?: 0 | 1 | 2; months?: 3 | 12 | 24; /** An edit of the open proposal (BP-24): Send replaces it. */ edit?: boolean; /** A what-size question ("how much collateral for $100,000?"): the card shows the collateral for that amount, uncapped, and cannot be sent. */ hypothetical?: boolean; /** The Safe cannot back this loan: the card says so (and what is missing) from the start, with no editor to flash and vanish. */ refusal?: PlanRefusal }
  | { kind: "compare"; cash: number; asset?: Asset; network?: Network }
  | { kind: "whatif"; asset?: Asset; cash?: number; network?: Network; /** The fall the user asked for, snapped to a slider step (VC-08). */ drop?: number; /** The asked fall was above the slider's range. */ capped?: boolean } // no loans: hypothetical loan of `cash` (default 10,000)
  | { kind: "explain"; topic: "how" | "health" | "liquidation" | "collateral" | "safe" | "reserve" }
  | { kind: "status" }
  /** Fix options for one at-risk loan (BP-22). Parameters only: the figures come from the server. */
  | { kind: "fix"; loanId: string }
  | { kind: "holdings" }
  | { kind: "addfunds" }
  | { kind: "suggestions"; items: string[] };

/** Set while a loan is at risk or liquidatable: the lender of the first such loan. Nothing invites a new loan then (VC-03). */
export type Urgent = { lender: string; /** The loan to fix: the id the fix card takes. */ loanId: string };

/** Starter chips for the Safe: only loans it can make, and no borrowing chip while it holds nothing or a loan needs attention. `max` is the most it can safely borrow. */
export const starterChips = (max: number, urgent?: Urgent): string[] =>
  urgent ? [`Fix my ${urgent.lender} loan`, "How does this work?"]
  : max < MIN_LOAN ? ["Add funds", "How does this work?"] : [`Borrow ${usd(max)}`, "How does this work?", "Compare lenders"];

/** The Ask greeting: what the Safe can do now. Co-signers are mentioned only when more than one owner must sign. */
export const greetingText = (safeName: string, threshold: number, max: number, urgent?: Urgent, hasAssets = false) => {
  const safeLabel = safeName === "My Safe" ? "Your Safe" : `Your Safe "${safeName}"`;
  const state = urgent ? "One of your loans needs attention first."
    : max >= MIN_LOAN ? `You can borrow up to ${usd(max)} against the crypto in ${safeName} without selling it.`
    : hasAssets ? `${safeLabel} has assets, but I couldn't find enough eligible collateral to offer a loan yet.`
    : `${safeLabel} is empty. Add crypto and I can show how much cash you could borrow against it.`;
  return `Hi. ${state} I only suggest; you${threshold > 1 ? " and your co-signers" : ""} approve every transaction here in the app.`;
};

export const depositLine = (safeName: string, network: string, asset: Asset, amount: number, value: number, max: number, urgent = false) =>
  `I see ${fmt(amount, Number.isInteger(amount) ? 0 : 2)} ${asset} (about ${usd(value)}) on ${network} in ${safeName}. ${urgent ? "One of your loans needs attention first." : max >= MIN_LOAN ? `You can borrow up to ${usd(max)} against it without selling it.` : "That is not enough to borrow against yet."}`;
