"use client";
// One click, one approval (flow-03). The plan card's "Approve in your wallet" first sends the plan
// to the Safe, then opens the proposal page. It leaves a short-lived mark in this tab so that page
// starts the owner's free approval signature at once. The mark is only a hint: the page still runs
// every check it runs for a manual click, and it never starts a paid action (Send / execute).
import { getJson } from "@/client/http";
import type { ProposalView } from "@/server/proposals/view";

const KEY = "la:approveIntent";
/** A mark older than this is ignored (the person may come back to the page much later). */
export const APPROVE_INTENT_TTL_MS = 2 * 60_000;

/** The random token of the last mark made by this page load. A tab that inherited a copy of sessionStorage (window.open) has no such token in memory, so it cannot use the copy. A full reload also forgets it: the page then just waits for a click. */
let token: string | null = null;

type Mark = { id: string; token: string; at: number };

/** Called right before navigating to the proposal page after a send from this tab. */
export function markApproveIntent(proposalId: string, now = Date.now()): void {
  token = crypto.randomUUID();
  try { sessionStorage.setItem(KEY, JSON.stringify({ id: proposalId, token, at: now } satisfies Mark)); } catch { /* storage blocked: the page just waits for a click */ }
}

/** True while a mark made at `at` may still start an approval. */
export const approveIntentFresh = (at: number, now = Date.now()) => Number.isFinite(at) && now - at >= 0 && now - at <= APPROVE_INTENT_TTL_MS;

/** When the mark was made, once per mark, and only if it is fresh, names this proposal and carries this page's token; else null. The record is removed first, so a reload never prompts again. */
export function readApproveIntent(proposalId: string, now = Date.now()): number | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    let m: Partial<Mark> | null = null;
    try { m = JSON.parse(raw); } catch { /* unreadable: treated as none */ }
    if (m?.id !== proposalId) return null; // another proposal's mark stays for its own page
    sessionStorage.removeItem(KEY);
    return !!token && m.token === token && typeof m.at === "number" && approveIntentFresh(m.at, now) ? m.at : null;
  } catch {
    return null;
  }
}

export const takeApproveIntent = (proposalId: string, now = Date.now()): boolean => readApproveIntent(proposalId, now) !== null;

/** What the person clicked: the cash, the collateral asset and amount, and the chain of the plan they saw. */
export type ClickedPlan = { cash: number; asset: string; chainId: number; collateral: number };

/** The stored proposal shows the collateral rounded (two decimals, or four digits under 1): allow that rounding and no more. */
const COLLATERAL_TOLERANCE = 0.006;

/** True when the stored proposal is the one that was clicked. A shared draft key can hand back an existing proposal with other terms (two tabs); then there is no auto-approval. Unreadable or unknown figures count as different. */
export function proposalMatches(p: Pick<ProposalView, "chainId" | "facts"> | undefined, clicked: ClickedPlan): boolean {
  if (!p || p.chainId !== clicked.chainId) return false;
  const [get, lock] = p.facts?.changes ?? [];
  const cash = Number(get?.amount.replace(/[^0-9.]/g, ""));
  const asset = lock?.amount.replace(/^[^\d]*[\d.,]+\s*/, "").trim();
  const collateral = Number(lock?.amount.match(/[\d.,]+/)?.[0].replace(/,/g, ""));
  return Number.isFinite(cash) && Math.abs(cash - clicked.cash) < 0.01 && asset === clicked.asset
    && Number.isFinite(collateral) && Math.abs(collateral - clicked.collateral) <= clicked.collateral * COLLATERAL_TOLERANCE;
}

/** After a send from this tab: mark the intent only if the proposal that came back is what was clicked. Never throws. */
export async function markIfMatches(address: string, proposalId: string, clicked: ClickedPlan): Promise<void> {
  try {
    const { proposal } = await getJson<{ proposal: ProposalView }>(`/api/safes/${address}/proposals/${proposalId}`);
    if (proposalMatches(proposal, clicked)) markApproveIntent(proposalId);
  } catch { /* cannot tell: open the page with no auto-approval */ }
}
