// Whether a plan can be drawn at all (BP-12): decided from the same live read as the borrow limit,
// before the plan card exists, so the card is never an editor that turns into a refusal a moment later.
import type { PlanRefusal } from "@/lib/blocks";
import { BALANCED_HF, DEFAULT_LEVELS, MIN_LOAN, minLoanFor } from "@/lib/loan-math";
import type { Asset } from "@/lib/types";
import { collateralFor, lenderLimit } from "@/lib/cash-plan";
import { borrowLimit, type LiveInputs } from "@/server/market-inputs";
import type { PlanCheck } from "@/server/agent/tools";
import { planChainOf } from "@/server/quote";
import { NETWORK_OF, type ChainId } from "@/shared/types";

/** The check a chat turn hands its plan tools: it reads the network the requested plan will be quoted on — the tool's, else the funded one among `eligible` (the owned served chains, in served order) like Get cash — and only the asset asked for. `known` are inputs already read. The answer says which network it checked so the plan block can carry it. */
export const planCheckFor = (read: (chainId: ChainId) => Promise<LiveInputs>, known: LiveInputs[] = [], eligible: readonly ChainId[] = [], editNetwork?: string): PlanCheck => async (cash, want) => {
  let chainId: ChainId;
  if (want.network !== undefined) {
    try { chainId = planChainOf(want); } catch { return null; } // a network with no loans is refused by the quote itself
    // A name in chat does not grant access to that chain; quote planning will enforce the same owned-network boundary.
    if (!eligible.includes(chainId)) return null;
  } else {
    const reads = eligible.flatMap((c) => { const i = known.find((k) => k.chainId === c); return i ? [i] : []; });
    const withAsset = want.asset ? reads.filter((i) => i.balances[want.asset!] > 0) : [];
    const assetPlan = withAsset.find((i) => planRefusal(i, cash, undefined, want.asset) === null);
    const preferredEdit = want.edit && editNetwork ? eligible.find((c) => NETWORK_OF[c] === editNetwork) : undefined;
    chainId = (preferredEdit ?? assetPlan?.chainId ?? withAsset[0]?.chainId ?? reads.find((i) => borrowLimit(i).max >= MIN_LOAN)?.chainId ?? reads[0]?.chainId) ?? 8453;
  }
  const inputs = known.find((i) => i.chainId === chainId) ?? (await read(chainId));
  return { refusal: planRefusal(inputs, cash, undefined, want.asset), network: NETWORK_OF[chainId] };
};

/** Null when some lender can fund at least its smallest loan against what the Safe holds. Otherwise the refusal, with about how much more collateral (dollars) the requested amount needs. */
export function planRefusal(inputs: LiveInputs, cash: number, targetHf = BALANCED_HF, only?: Asset): PlanRefusal | null {
  let need = Infinity;
  for (const f of inputs.lenders) {
    if (!f.venue) continue;
    for (const asset of Object.keys(f.venue.markets) as Asset[]) {
      if (only && asset !== only) continue;
      const m = f.venue.markets[asset]!;
      const price = f.prices[asset] ?? inputs.prices[asset];
      const held = inputs.balances[asset] * price;
      const min = minLoanFor(f.markets[asset]?.minBorrow);
      // Eligible exactly when the quote can lock its (rounded-up) collateral for the smallest loan.
      const fits = collateralFor(min, targetHf, price, m, asset) <= inputs.balances[asset];
      if (fits && Math.min(lenderLimit(f.venue, asset, inputs.balances[asset], price, targetHf) ?? 0, f.liquidity) >= min) return null;
      const target = Math.max(cash, min, MIN_LOAN);
      need = Math.min(need, Math.max(0, collateralFor(target, targetHf, price, m, asset) * price - held));
    }
  }
  return { reason: "not_enough_collateral", needUsd: Number.isFinite(need) ? Math.ceil(need) : Math.max(cash, MIN_LOAN) };
}
