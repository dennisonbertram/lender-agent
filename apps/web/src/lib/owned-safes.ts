// Owned-Safe discovery shared by the server routes and the client picker: one row per Safe, merged from
// each network's independently verified slice (BP-04). The same merge runs on the aggregate endpoint, on
// each single-network response, and on the rows the client stitches together — so the progressive result is
// identical to the all-at-once one. Pure: no I/O.
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import type { FoundSafe } from "@/server/safes";
import { isChainId, type Address, type ChainId } from "@/shared/types";

/** The networks searched for owned Safes: the ones the app serves (Base and Arbitrum), in declared order. */
export const DISCOVERY_CHAIN_IDS: ChainId[] = SERVED_CHAIN_IDS.filter((id): id is ChainId => isChainId(id));

/** One network's verified contribution to an owned-Safe row: ownership confirmed on-chain, plus value when readable. */
export type OwnedSafeSlice = {
  address: Address;
  chainId: ChainId;
  threshold: number;
  ownerCount: number;
  owners: { address: Address; ens?: string }[];
  balanceUsd?: number;
  assets?: { symbol: string; amount: number }[];
};

type AggregatedSafe = FoundSafe & Required<Pick<FoundSafe, "networkDetails" | "balanceChainIds">>;

/**
 * One row per Safe, merged from the networks' verified slices in served-network order — the same rows however
 * the slices arrived. A network whose balance could not be read removes the total for the whole Safe (never a
 * partial guess); the first-found network supplies the headline owners and threshold.
 */
export function mergeOwnedSafeSlices(slices: readonly OwnedSafeSlice[]): FoundSafe[] {
  const order = new Map(DISCOVERY_CHAIN_IDS.map((id, i) => [id, i]));
  const sorted = [...slices].sort((a, b) => (order.get(a.chainId) ?? DISCOVERY_CHAIN_IDS.length) - (order.get(b.chainId) ?? DISCOVERY_CHAIN_IDS.length));
  const found = new Map<string, AggregatedSafe>();
  for (const c of sorted) {
    const prev = found.get(c.address.toLowerCase());
    if (prev) {
      prev.chainIds.push(c.chainId);
      prev.networkDetails.push({ chainId: c.chainId, threshold: c.threshold, ownerCount: c.ownerCount, owners: c.owners });
      if (prev.balanceUsd === undefined || c.balanceUsd === undefined) { delete prev.balanceUsd; delete prev.assets; prev.balanceChainIds = []; }
      else {
        prev.balanceUsd += c.balanceUsd;
        prev.balanceChainIds.push(c.chainId);
        const by = new Map<string, number>();
        for (const a of [...(prev.assets ?? []), ...(c.assets ?? [])]) by.set(a.symbol, (by.get(a.symbol) ?? 0) + a.amount);
        prev.assets = [...by].map(([symbol, amount]) => ({ symbol, amount }));
      }
    }
    else {
      const { chainId: id, ...rest } = c;
      found.set(c.address.toLowerCase(), { ...rest, chainIds: [id], balanceChainIds: c.balanceUsd === undefined ? [] : [id],
        networkDetails: [{ chainId: id, threshold: c.threshold, ownerCount: c.ownerCount, owners: c.owners }] });
    }
  }
  return [...found.values()];
}
