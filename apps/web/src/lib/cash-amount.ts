// The Get cash amount rules (BP-34, VC-07): one place for what the amount field says. The planner, its
// chips and the server's limit check all read this, so the field and the Next button cannot disagree.
import { usd } from "@/lib/format";
import { MIN_LOAN, parseUsd } from "@/lib/loan-math";

export type AmountCheck =
  | { ok: true; cash: number; message: string }
  | { ok: false; cash: number | null; message: string; tone: "error" | "hint"; /** Set when the amount is above the maximum: the chip "Use $X". */ useMax?: number };

/** "10k", "$10,000" or a bare "500"; null when it is not a positive amount. */
export const parseCash = (text: string): number | null => {
  const n = parseUsd(text) ?? Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** `max` is the most the Safe can safely borrow now (Balanced, any lender and asset). */
export function checkAmount(text: string, max: number): AmountCheck {
  const hint = `With what's in this Safe you can borrow ${usd(MIN_LOAN)} to ${usd(max)}.`;
  const cash = parseCash(text);
  if (!text.trim()) return { ok: false, cash: null, message: hint, tone: "hint" };
  if (cash === null) return { ok: false, cash: null, message: "Use numbers only, for example $5,000.", tone: "error" };
  if (cash < MIN_LOAN) return { ok: false, cash, message: `The smallest loan is ${usd(MIN_LOAN)}.`, tone: "error" };
  if (cash > max) return { ok: false, cash, message: `That's more than this Safe can safely borrow against. The most is ${usd(max)}.`, tone: "error", useMax: max };
  return { ok: true, cash, message: hint };
}
