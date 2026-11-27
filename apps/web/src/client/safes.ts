"use client";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListedSafe } from "@/server/auth/access";
import type { FoundSafe, SafeSummary } from "@/server/safes";
import { DISCOVERY_CHAIN_IDS, mergeOwnedSafeSlices, type OwnedSafeSlice } from "@/lib/owned-safes";

import { ApiError, getJson } from "@/client/http";

export { ApiError };

export const safesKey = ["safes"] as const;
export const safeSummaryKey = (address: string) => ["safes", "summary", address.toLowerCase()] as const;

/** The signed-in user's saved Safes. `wallet` only scopes the cache — the list is the session's either way — so a wallet switch never shows the previous account's list. */
export const useSafes = (wallet?: string) =>
  useQuery({
    queryKey: wallet ? [...safesKey, "list", wallet.toLowerCase()] : safesKey,
    queryFn: async () => (await getJson<{ safes: ListedSafe[] }>("/api/safes")).safes,
  });

const ownedKey = (wallet: string | undefined) => [...safesKey, "owned", wallet?.toLowerCase() ?? ""] as const;

export type OwnedSafesQuery = {
  /** Rows merged from the networks that answered so far — grows as each request lands; undefined until the first answer. */
  data: FoundSafe[] | undefined;
  /** First load still in flight (some network has not answered yet). */
  isLoading: boolean;
  /** Any network request in flight, including a retry — `data` keeps its rows meanwhile. */
  isFetching: boolean;
  /** The first failed network's error, when one could not be looked up; the others' rows stay in `data`. */
  error: Error | null;
  /** Networks whose lookup failed (empty when all answered). */
  failedChainIds: number[];
  /** Retries the failed networks, or re-checks every network when none failed; rows are never cleared by a failed retry. */
  refetch: () => Promise<unknown>;
};

/**
 * Safes the wallet owns, discovered progressively: one request per served network, each merged in as it completes.
 * A network that fails keeps the others' rows and retries on its own; a wallet switch can never show another wallet's Safes.
 */
export function useOwnedSafes(wallet?: string): OwnedSafesQuery {
  return useQueries({
    queries: DISCOVERY_CHAIN_IDS.map((chainId) => ({
      queryKey: [...ownedKey(wallet), chainId],
      enabled: !!wallet,
      queryFn: async () =>
        (await getJson<{ safes: FoundSafe[] }>(`/api/safes/owned?chainId=${chainId}`)).safes.map(
          (s): OwnedSafeSlice => ({ address: s.address, chainId: s.chainIds[0], threshold: s.threshold, ownerCount: s.ownerCount, owners: s.owners, ...(s.balanceUsd === undefined ? {} : { balanceUsd: s.balanceUsd, assets: s.assets }) }),
        ),
    })),
    combine: (results): OwnedSafesQuery => {
      const failed = results.filter((r) => r.isError);
      return {
        data: results.some((r) => r.data !== undefined) ? mergeOwnedSafeSlices(results.flatMap((r) => r.data ?? [])) : undefined,
        isLoading: results.some((r) => r.isLoading),
        isFetching: results.some((r) => r.isFetching),
        error: (failed[0]?.error as Error | undefined) ?? null,
        failedChainIds: DISCOVERY_CHAIN_IDS.filter((_, i) => results[i]?.isError === true),
        refetch: () => (wallet ? Promise.all((failed.length ? failed : results).map((r) => r.refetch())) : Promise.resolve()),
      };
    },
  });
}

export function useAddSafe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { address: string; name?: string }) =>
      getJson<{ address: string; agent: boolean }>("/api/safes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: safesKey }),
  });
}

export const useSafeSummary = (address: string) =>
  useQuery({
    queryKey: safeSummaryKey(address),
    queryFn: () => getJson<SafeSummary>(`/api/safes/${address}`),
    // The header line must follow the monitor: quickly until it is watching, then once a minute so a stall shows.
    refetchInterval: (q) => (q.state.data && !q.state.data.watching ? 15_000 : 60_000),
  });
