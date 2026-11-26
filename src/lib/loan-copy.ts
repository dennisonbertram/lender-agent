import { fmt, usd, type Venue } from "@/data";
import { MIN_LOAN, maxPriceDrop, type HealthStatus } from "@/lib/loan-math";
import type { Quote } from "@/lib/cash-plan";

export const needsSignatures = (n: number) => `needs ${n} signature${n === 1 ? "" : "s"}`;

/** One sentence: how far the collateral price can fall before liquidation. */
export function cushionLine(asset: string, price: number, liq: number, debt: number): string {
  if (debt <= 0) return "No debt, so nothing can be liquidated.";
  if (price < liq) return `${asset} is ${usd(liq - price)} below the liquidation price (${usd(liq)}).`;
  const pct = Math.round((1 - liq / price) * 100);
  if (pct < 1) return `${asset} is less than 1% above the liquidation price.`;
  return `${asset} can fall ${pct}% (to ${usd(liq)}) before this loan is liquidated.`;
}

/** Short loan-row line: amount borrowed plus how far the collateral price can fall. */
export function loanRowLine(asset: string, price: number, liq: number, debt: number): string {
  if (debt <= 0) return "No debt";
  const borrowed = `Borrowed ${usd(debt)} · `;
  if (price < liq) return `${borrowed}${asset} is below its liquidation price`;
  const pct = Math.round((1 - liq / price) * 100);
  if (pct < 1) return `${borrowed}${asset} is less than 1% above liquidation`;
  return `${borrowed}${asset} can fall ${pct}% before liquidation`;
}

/** Percent of the liquidation limit in use, rounded. 0 when there is no debt. */
export function limitUsedPct(hf: number): number {
  return Number.isFinite(hf) ? Math.round(100 / hf) : 0;
}

export type Severity = "now" | "close" | "risk";
/** now: hf < 1. close: price can fall less than 5% before liquidation (maxPriceDrop(hf) < 0.05). risk: otherwise. */
export function severity(hf: number): Severity {
  return hf < 1 ? "now" : maxPriceDrop(hf) < 0.05 ? "close" : "risk";
}

export function alertTitle(venue: string, hf: number): string {
  const s = severity(hf);
  return `${venue} loan ${s === "now" ? "can be liquidated now" : s === "close" ? "is very close to liquidation" : "is at risk"}`;
}

/** Risk banner text. Called when status is "risk" or "liquidatable". */
export function riskBanner(hf: number, fix: "none" | "draft" | "queued"): string {
  const s = severity(hf);
  const first = s === "now" ? "This loan can be liquidated now." : s === "close" ? "Very close to liquidation." : "Below your At-risk level.";
  const second = { none: "Add collateral or repay.", draft: "A fix is drafted in chat. Send it to Safe, then sign.", queued: "A fix is waiting for signatures in your Safe." }[fix];
  return `${first} ${second}`;
}

/** Signatures a Safe needs, from its threshold text such as "2 of 3". Falls back to 2. */
export function requiredSignatures(threshold: string): number {
  return parseInt(threshold, 10) || 2;
}

/** One sentence for an open proposal (stage 0 to 2); `needs` is the Safe's required signatures. */
export function stageLine(stage: number, needs: number): string {
  const sig = (n: number) => `${n} signature${n === 1 ? "" : "s"}`;
  if (stage === 0) return "Drafted, not yet sent to Safe.";
  if (stage === 3) return "Done. Executed in Safe.";
  if (stage === 1) return `In your Safe queue. Needs ${sig(needs)}.`;
  return needs === 1 ? "Signed. Waiting for execution in Safe." : `1 of ${needs} signed. Needs ${needs - 1} more ${needs - 1 === 1 ? "signature" : "signatures"}.`;
}

/** Why Morpho: numbers come from the venue list. */
export function whyMorphoLine(venues: Venue[]): string {
  const m = venues.find((v) => v.id === "morpho")!;
  const a = venues.find((v) => v.id === "aave")!;
  return `${m.name} charges ${m.apr}% a year, ${a.name} ${a.apr}%: ${usd(((a.apr - m.apr) / 100) * 10000)} less per $10,000. Morpho also lets you borrow a bit more against the same ETH. The trade-off: it has much less money to lend ($${m.liquidity}M vs $${a.liquidity}M), so big loans and quick exits can be harder.`;
}

export function attentionCounts(statuses: HealthStatus[]) {
  const count = (...k: HealthStatus[]) => statuses.filter((s) => k.includes(s)).length;
  return { act: count("risk", "liquidatable"), watch: count("watch") };
}

/** Sidebar line, same counts as the overview headline, e.g. "1 needs action, 2 to watch". */
export function attentionLine(statuses: HealthStatus[]): string {
  const { act, watch } = attentionCounts(statuses);
  return [act && `${act} ${act === 1 ? "needs" : "need"} action`, watch && `${watch} to watch`].filter(Boolean).join(", ");
}

/** One status line per Safe in the Safe picker. */
export function safeStatusLine(statuses: HealthStatus[], agent: boolean): string {
  return attentionLine(statuses) || (!agent ? "Agent not added" : statuses.length === 0 ? "No loans yet" : "All loans healthy");
}

/** One-line answer to "am I OK?" from the statuses of a Safe's loans. */
export function statusSentence(statuses: HealthStatus[], worstVenue?: string): string {
  const n = statuses.length;
  if (n === 0) return "";
  const count = (k: HealthStatus) => statuses.filter((s) => s === k).length;
  const L = count("liquidatable"), R = count("risk"), W = count("watch");
  const toWatch = W ? ` ${W} to watch.` : "";
  if (L) {
    const head = L === 1 ? `${worstVenue ?? "1 loan"} can be liquidated now.` : `${L} loans can be liquidated now.`;
    return head + (R ? ` ${R} more ${R === 1 ? "needs" : "need"} action now.` : "") + toWatch;
  }
  if (R) return `${R} ${R === 1 ? "loan needs" : "loans need"} action now.${toWatch}`;
  if (W === 0) return n === 1 ? "Your loan is fine." : `All ${n} loans are fine.`;
  const fine = n - W;
  if (fine === 0) return `${W} ${W === 1 ? "loan" : "loans"} to watch.`;
  return `${fine} ${fine === 1 ? "loan is" : "loans are"} fine.${toWatch}`;
}

/** Loan limit bar: fill %, position of the 100% tick (null at or under 100%), and its label. */
export function limitBar(used: number): { fill: number; tick: number | null; text: string } {
  return used <= 100
    ? { fill: used, tick: null, text: `${used}% used · liquidated at 100%` }
    : { fill: 100, tick: 10000 / used, text: `${used}% used · ${used - 100}% over the limit` };
}

/** Accessible name of the header chat button. */
export function agentButtonLabel(risk: number): string {
  return risk === 0 ? "Lender agent" : `Lender agent, ${risk} ${risk === 1 ? "loan needs" : "loans need"} attention`;
}

/** " on the full $50,000 loan" when the figure covers an existing loan, else "". */
export const scopeText = (q: Quote) => (q.scope === "added" ? ` on the full ${usd(q.debt)} loan` : "");

/** Explains why an added amount is priced at the loan's own rate. */
export const rateNote = (q: Quote) => (q.scope === "added" && q.apr !== q.venue.apr ? ` That is your loan's current rate. New ${q.venue.name} loans start at ${q.venue.apr}%.` : "");

/** The one name for the action, in the centre, the chat and the success message. */
export function actionName(q: Quote, cash: number): { title: string; past: string } {
  const v = q.venue.name;
  return q.scope === "added"
    ? { title: `Add ${usd(cash)} to your ${v} loan`, past: `Added ${usd(cash)} to your ${v} loan.` }
    : { title: `Open a ${usd(cash)} ${v} loan`, past: `Your ${usd(cash)} ${v} loan is open.` };
}

/** The two summary lines above Send on the Get cash plan screen. */
export function planSummary(p: { cash: number; venue: string; apr: number; collateral: number; asset: string; liqPrice: number; adding: boolean }): [string, string] {
  return [
    `${usd(p.cash)} from ${p.venue} at ${p.apr}% · locks ${fmt(p.collateral, 2)} ${p.asset}${p.adding ? " more" : ""}`,
    `Safe unless ${p.asset} falls below ${usd(p.liqPrice)}`,
  ];
}

/** Header line under the chat title: what the agent is doing on this Safe. */
export function agentStatusLine(active: boolean, statuses: HealthStatus[]): string {
  if (!active) return "Not watching this Safe";
  const n = statuses.length;
  if (n === 0) return "Ready. No loans to watch yet.";
  const { act } = attentionCounts(statuses);
  return `Watching ${n} ${n === 1 ? "loan" : "loans"}${act ? ` · ${act} ${act === 1 ? "needs" : "need"} action` : ""}`;
}

/** Which loans the demo price drop moves. Mirrors the grouping in simulateDrop (store.tsx). */
export const demoDropNote = (asset: string) => (asset === "WBTC" ? "Moves every WBTC loan." : "Moves every ETH and wstETH loan.");
