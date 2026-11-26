// Plain-words copy for the one borrow limit (VC-02): the "Why $X?" sentence and the Was/now line.
import { usd } from "@/lib/format";

type LimitFacts = { max: number; lenderName: string | null; asset: string | null; lenderId?: string | null };
export type PreviousPlan = { lender: string; apr: number; yearly: number };

/** "Why $4,000? It is the most ...". Empty when there is no limit. The same string on every surface. */
export function limitWhy(limit: LimitFacts, safetyWord: string): string {
  if (!limit.lenderName || !limit.asset || limit.max <= 0) return "";
  return `Why ${usd(limit.max)}? It is the most you can borrow against your ${limit.asset} at the ${safetyWord} safety level, from ${limit.lenderName}, the lender that allows the most.`;
}

/** Splits a `limitWhy` string into the button label and the sentence under it. */
export function splitWhy(why: string): { label: string; text: string } {
  const i = why.indexOf("? ");
  return i < 0 ? { label: why, text: "" } : { label: why.slice(0, i + 1), text: why.slice(i + 2) };
}

export const wasNowLine = (prev: PreviousPlan, next: PreviousPlan): string =>
  `Was about ${usd(prev.yearly)} a year at ${prev.apr}% with ${prev.lender}; now about ${usd(next.yearly)} a year at ${next.apr}% with ${next.lender}.`;
