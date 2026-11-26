import { fmt, usd } from "@/lib/format";
import type { Amounts, Loan } from "@/lib/types";
import { collateralNeeded, healthFactor, maxPriceDrop, repayNeeded } from "@/lib/loan-math";

// The 1e-9 keeps float noise (7.1 / 2 * 10 = 35.50000000000001) from rounding up an extra step.
const up = (x: number, step: number) => Math.ceil(x / step - 1e-9) * step;

/** Amounts that each bring the loan to `warn`: collateral rounded up to 0.1 (min 0.1), repay rounded up to 1,000 (min 1,000). */
export function alertAmounts(loan: Loan, price: number, warn: number): { addColl: number; repay: number } {
  const addColl = Math.max(0.1, Math.round(up(collateralNeeded(loan.collAmount, price, loan.lt, loan.debt, warn), 0.1) * 10) / 10);
  const repay = Math.max(1000, up(repayNeeded(loan.collAmount * price, loan.lt, loan.debt, warn), 1000));
  return { addColl, repay };
}

/** Half of each, rounded up the same way. Reaches warn too: (C + a/2) / (D - r/2) = T when a and r each reach T alone. */
export function bothAmounts(addColl: number, repay: number): { addColl: number; repay: number } {
  return { addColl: Math.max(0.1, Math.round(up(addColl / 2, 0.1) * 10) / 10), repay: Math.max(1000, up(repay / 2, 1000)) };
}

export type AlertOption = { k: "coll" | "repay" | "both"; label: string; addColl: number; repay: number; hf: number; sub: string; short: boolean; recommended: boolean };

/** The three options for an alert message, priced at the alert's price, checked against the Safe's live balances on the loan's network. */
export function alertOptions(m: { snap: Loan; price: number; addColl: number; repay: number }, balances: Amounts): AlertOption[] {
  const { snap: l, price } = m;
  const b = bothAmounts(m.addColl, m.repay);
  const mk = (k: AlertOption["k"], label: string, addColl: number, repay: number): AlertOption => {
    const hf = healthFactor((l.collAmount + addColl) * price, l.lt, l.debt - repay);
    const shortColl = addColl > 0 && balances[l.collAsset] < addColl;
    const shortDebt = repay > 0 && balances[l.debtAsset] < repay;
    const cost = addColl * price + repay;
    const sub = shortColl ? `Needs ${addColl} ${l.collAsset}. Your Safe has ${fmt(balances[l.collAsset], 2)} ${l.collAsset}.`
      : shortDebt ? `Needs ${fmt(repay)} ${l.debtAsset}. Your Safe has ${fmt(balances[l.debtAsset])} ${l.debtAsset}.`
      : `${addColl > 0 ? "About " : ""}${usd(cost)} from your Safe`;
    return { k, label, addColl, repay, hf, sub, short: shortColl || shortDebt, recommended: false };
  };
  const all = [
    mk("coll", `Add ${m.addColl} ${l.collAsset} collateral`, m.addColl, 0),
    mk("repay", `Repay ${fmt(m.repay)} ${l.debtAsset}`, 0, m.repay),
    mk("both", `Add ${b.addColl} ${l.collAsset} and repay ${fmt(b.repay)} ${l.debtAsset}`, b.addColl, b.repay),
  ];
  const cost = (o: AlertOption) => o.addColl * price + o.repay;
  const usable = all.filter((o) => !o.short);
  // Every option reaches the warn level, so the cheapest usable one is the recommendation. Ties keep the existing order.
  const best = usable.length > 1 ? usable.reduce((a, o) => (cost(o) < cost(a) ? o : a)) : undefined;
  if (best) best.recommended = true;
  return [...(best ? [best] : []), ...usable.filter((o) => o !== best), ...all.filter((o) => o.short)];
}

/** One summary line under the usable options; "" when none is usable. */
export function optionsNote(opts: AlertOption[], asset: string): string {
  const usable = opts.filter((o) => !o.short);
  if (!usable.length) return "";
  const drop = Math.round(maxPriceDrop(Math.min(...usable.map((o) => o.hf))) * 100);
  return `${opts.some((o) => o.recommended) ? "Recommended uses the least money from your Safe. " : ""}Afterwards ${asset} could fall about ${drop}% before liquidation.`;
}

export type AlertState = "live" | "chosen" | "outdated" | "replaced" | "resolved" | "closed" | "fixing";

/** Checked in this order: closed, replaced, resolved (at the warn level), chosen, fixing (an open fix, nothing chosen here), outdated, live. */
export function alertState(a: { hf: number; chosen?: string }, ctx: { newer: boolean; liveHf: number | null; warn: number; openFix: boolean }): AlertState {
  if (ctx.liveHf === null) return "closed";
  if (ctx.newer) return "replaced";
  if (ctx.liveHf >= ctx.warn) return "resolved";
  if (a.chosen && ctx.openFix) return "chosen";
  if (ctx.openFix) return "fixing";
  if (Math.abs(ctx.liveHf - a.hf) >= 0.005) return "outdated";
  return "live";
}

/** What the standing repay rule does at the alert: draft when the Safe's stablecoin covers the repay, explain when it does not, nothing when off. */
export function ruleAction(ruleOn: boolean, repay: number, balance: number): "draft repay" | "explain" | null {
  return !ruleOn ? null : balance >= repay ? "draft repay" : "explain";
}

/** An alert is on topic on the overview and on its own loan's page. */
export const alertOnTopic = (view: { name: string; id?: string }, loanId: string): boolean =>
  view.name === "home" || (view.name === "loan" && view.id === loanId);
