import { usd, type Asset, type Network } from "@/data";
import { MIN_LOAN } from "@/lib/loan-math";

/** A generated UI block the agent can post in the chat. In phase 2 each is the typed result of an LLM tool call. */
export type UIBlock =
  | { kind: "plan"; cash: number; asset?: Asset; network?: Network; venueId?: string; hfIdx?: 0 | 1 | 2; months?: 3 | 12 | 24 }
  | { kind: "compare"; cash: number; asset?: Asset; network?: Network }
  | { kind: "whatif"; asset?: Asset; cash?: number } // no loans: hypothetical loan of `cash` (default 10,000)
  | { kind: "explain"; topic: "how" | "health" | "liquidation" | "collateral" | "safe" | "reserve" }
  | { kind: "status" }
  | { kind: "holdings" }
  | { kind: "addfunds" }
  | { kind: "suggestions"; items: string[] };

/** Starter chips for the Safe: only loans it can make, and no borrowing chip while it holds nothing. `max` is the most it can safely borrow. */
export const starterChips = (max: number): string[] =>
  max < MIN_LOAN ? ["Add funds", "How does this work?"] : [`Borrow ${usd(max)}`, "How does this work?", "Compare lenders"];

/** The Ask greeting: what the Safe can do now. Co-signers are mentioned only when more than one owner must sign. */
export const greetingText = (safeName: string, threshold: number, max: number) =>
  `Hi. ${max < MIN_LOAN ? `${safeName} is empty. Add crypto and I can show how much cash you could borrow against it.` : `You can borrow up to ${usd(max)} against the crypto in ${safeName} without selling it.`} I only suggest; you${threshold > 1 ? " and your co-signers" : ""} approve every transaction in Safe.`;

/** The reply to the demo deposit: what 5 ETH is worth and, if it is enough, what it can borrow. */
export const depositLine = (safeName: string, network: string, value: number, max: number) =>
  `I see 5 ETH (about ${usd(value)}) on ${network} in ${safeName}. ${max >= MIN_LOAN ? `You can borrow up to ${usd(max)} against it without selling it.` : "That is not enough to borrow against yet."}`;
