// BP-36: the cross-network plan with a real quote. The domain library decides which plans exist (`plansAcross`, `choosePlan`,
// `moveReason`); this adds what only the aggregator knows: whether a route exists, the fee and time from the quote, and the
// collateral the loan is sized on, which is the quote's minimum received (the guaranteed part), not what we send.
import { isAddressEqual } from "viem";
import { choosePlan, moveReason, planFor, plansAcross, type CashPlan, type Need } from "@/lib/cash-plan";
import { balancesOn } from "@/lib/networks";
import type { OpenSpec } from "@/lib/proposals";
import type { Asset, Loan, Network, NetworkConfig, Safe, Venue } from "@/lib/types";
import type { Address } from "@/shared/types";
import { fromRaw, moveToken, toRaw } from "./tokens";
import type { AggregatorQuote, BridgeAggregator, MoveChain, QuoteParams } from "./types";

export type PlanDeps = {
  aggregator: BridgeAggregator;
  networks: readonly NetworkConfig[];
  chainOf: (network: Network) => MoveChain;
};

export type CrossPlanInput = {
  safe: Safe;
  safeAddress: Address;
  need: Need;
  prices: Record<Asset, number>;
  venues: readonly Venue[];
  loans: Loan[];
};

export type CrossNetworkPlan = {
  choice: { plan: CashPlan; alternative?: { plan: CashPlan; saves: number } };
  /** Every plan that can be offered: same-network ones and the cross-network ones with a route. */
  plans: CashPlan[];
  /** The reason sentence for the move row (r33), or null when the plan has no move. */
  reason: string | null;
  /** The quote behind the chosen plan's move, and behind the alternative's. */
  quote?: AggregatorQuote;
  alternativeQuote?: AggregatorQuote;
  /** The loan drafted once the move has arrived. */
  then?: OpenSpec;
};

const minutesOf = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));
const up2 = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;

/**
 * The quote only counts when it answers the exact request it was asked: the same networks, the same tokens (and the decimals
 * we know them by), the same source amount, and the Safe as sender and recipient. An answer to a different request — a
 * substituted chain, token, amount or Safe — is refused, never coerced or silently swapped back for the requested fields.
 */
const answersRequest = (q: AggregatorQuote, p: QuoteParams & { fromDecimals: number; toDecimals: number }): boolean =>
  q.fromChain === p.fromChain && q.toChain === p.toChain
  && isAddressEqual(q.fromToken, p.fromToken) && isAddressEqual(q.toToken, p.toToken)
  && q.fromDecimals === p.fromDecimals && q.toDecimals === p.toDecimals
  && q.fromAmount === p.fromAmount
  && isAddressEqual(q.fromAddress, p.address) && isAddressEqual(q.toAddress, p.address);

export const openSpecOf = (plan: CashPlan, asset: Asset, safeAddress: string): OpenSpec => ({
  kind: "open", venueId: plan.venue.id, asset, amount: plan.collateral, borrow: plan.debt - plan.existingDebt, safeId: safeAddress.toLowerCase(), network: plan.network,
});

export async function planCrossNetwork(deps: PlanDeps, input: CrossPlanInput): Promise<CrossNetworkPlan | null> {
  const { safe, need, prices, venues, loans, safeAddress } = input;
  const { aggregator, networks, chainOf } = deps;
  const from = need.network;
  const have = balancesOn(safe, from)[need.asset];
  // The library decides which plans exist; the move rows in this first pass are placeholders until the aggregator answers.
  const first = plansAcross(safe, need, prices, venues, loans, networks, (f, t, asset, amount) => ({ from: f, to: t, asset, amount, feeUsd: 0, minutes: 1 }));
  const quoteOf = new Map<CashPlan, AggregatorQuote>();

  const refine = async (plan: CashPlan): Promise<CashPlan | null> => {
    const move = plan.move!;
    const src = moveToken(need.asset, chainOf(from));
    const dst = moveToken(need.asset, chainOf(move.to));
    if (!src || !dst || !plan.feasible) return null;
    const ask = async (units: number): Promise<AggregatorQuote | null> => {
      const req = { fromChain: chainOf(from), toChain: chainOf(move.to), fromToken: src.address, toToken: dst.address, fromAmount: toRaw(units, src.decimals), address: safeAddress, fromDecimals: src.decimals, toDecimals: dst.decimals };
      const q = await aggregator.quote(req);
      return q && answersRequest(q, req) ? q : null;
    };
    // First quote: how much of what is sent is guaranteed to arrive. Then send enough that the guaranteed part covers the collateral.
    const probe = await ask(plan.collateral);
    if (!probe) return null;
    const ratio = Number(probe.toAmountMin) / Number(probe.fromAmount) * 10 ** (probe.fromDecimals - probe.toDecimals);
    if (!(ratio > 0)) return null;
    const send = up2(plan.collateral / Math.min(ratio, 1));
    if (send > have) return null;
    const q = send === plan.collateral ? probe : await ask(send);
    if (!q) return null;
    const arrives = fromRaw(q.toAmountMin, q.toDecimals);
    const venue = venues.find((v) => v.id === plan.venue.id)!;
    const sized = planFor({ ...need, network: move.to, collateral: arrives }, have, prices[need.asset], venue, loans);
    const out: CashPlan = { ...sized, feasible: sized.feasible && send <= have, move: { from, to: move.to, asset: need.asset, amount: send, feeUsd: q.feeUsd, minutes: minutesOf(q.durationSec) } };
    quoteOf.set(out, q);
    return out;
  };

  const refined = await Promise.all(first.map(async (p) => (p.move ? refine(p) : p)));
  const plans = refined.filter((p): p is CashPlan => p !== null).sort((a, b) => a.apr - b.apr);
  const choice = choosePlan(plans);
  if (!choice) return null;
  const quote = quoteOf.get(choice.plan);
  return {
    choice, plans,
    reason: moveReason(choice.plan, plans, networks),
    ...(quote ? { quote, then: openSpecOf(choice.plan, need.asset, safeAddress) } : {}),
    ...(choice.alternative && quoteOf.get(choice.alternative.plan) ? { alternativeQuote: quoteOf.get(choice.alternative.plan)! } : {}),
  };
}
