// What the agent says about a move, in the decided wording (r33, OC-04). No figure comes from the model (G1): every number
// here is the quote's or the chain's.
import { fmt, usd } from "@/lib/format";
import type { Asset } from "@/lib/types";
import type { Hex } from "@/shared/types";
import { chainName } from "./networks";
import type { MoveChain } from "./types";

export const trackLink = (txHash: Hex) => `https://scan.li.fi/tx/${txHash}`;

/** The arrival message: the same sentence as the library's `done` for a move (asserted by a test), with the amount that arrived. */
export function arrivedLine(amount: number, asset: Asset, toChain: MoveChain, planned: number): string {
  const base = `Your ${fmt(amount, 2)} ${asset} is on ${chainName(toChain)} now, in the same Safe. Step 2 of 2: sign the loan below.`;
  return amount < planned * 0.999 ? `${base} Slightly less arrived than planned (${fmt(planned, 2)} ${asset}), so the loan is planned on what arrived.` : base;
}

export const noLoanYet = (toChain: MoveChain) => `I can't draft a loan on ${chainName(toChain)} yet, so there is no step 2 here. Your funds are in your Safe on ${chainName(toChain)}.`;

export function delayedLine(toChain: MoveChain, minutes: number, source: Hex): string {
  return `Your move to ${chainName(toChain)} is taking longer than the quoted about ${minutes} minutes. It has not failed: a bridge can be slow, and I keep watching. Follow it here: ${trackLink(source)}. I draft the loan, step 2, only once the funds have arrived.`;
}

export function partialLine(amountText: string, asset: Asset, fromChain: MoveChain, toChain: MoveChain, source: Hex): string {
  return `Your move of ${amountText} ${asset} to ${chainName(toChain)} only partly completed: the bridge delivered a different token than ${asset}. It is in your Safe on ${chainName(toChain)}, not on ${chainName(fromChain)}. I did not draft a loan. Details: ${trackLink(source)}.`;
}

export function refundedLine(amountText: string, asset: Asset, fromChain: MoveChain, toChain: MoveChain, source: Hex): string {
  return `Your move of ${amountText} ${asset} to ${chainName(toChain)} was refunded by the bridge. The funds are back in your Safe on ${chainName(fromChain)}, not on ${chainName(toChain)}. I did not draft a loan. Details: ${trackLink(source)}.`;
}

export function failedLine(amountText: string, asset: Asset, fromChain: MoveChain, toChain: MoveChain, source: Hex): string {
  return `Your move of ${amountText} ${asset} to ${chainName(toChain)} failed. The funds are not on ${chainName(toChain)}: they are still on ${chainName(fromChain)} or held by the bridge for a refund. I did not draft a loan. Check where they are: ${trackLink(source)}.`;
}

export const revertedLine = (amountText: string, asset: Asset, fromChain: MoveChain) => `The move failed in Safe: the transaction reverted. Nothing moved. You still hold your ${amountText} ${asset} on ${chainName(fromChain)}.`;

/** The one fees line of a move card (OC-01: the move line itself carries no fee). */
export const moveFeesLine = (feeUsd: number) => `One-time network fee for the move: about ${usd(Math.round(feeUsd))}. The loan's fee is shown with the loan, in step 2.`;

export const redraftedLine = (toChain: MoveChain) => `The quote for your move to ${chainName(toChain)} ran out before it was signed, so I took it out of your Safe queue. Here is a fresh draft.`;
export const noRedraftLine = (toChain: MoveChain) => `The quote for your move to ${chainName(toChain)} ran out before it was signed, and the bridge has no route for it right now, so I have not drafted a new one. Ask me again later. You still hold your funds.`;
