"use client";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListedSafe } from "@/server/auth/access";
import type { FoundSafe, SafeSummary } from "@/server/safes";
import { DISCOVERY_CHAIN_IDS, mergeOwnedSafeSlices, type OwnedSafeSlice } from "@/lib/owned-safes";

import { ApiError, getJson } from "@/client/http";

export { ApiError };

export const safesKey = ["safes"] as const;
export const safeSummaryKey = (address: string) => ["safes", "summary", address.toLowerCase()] as const;

const expectedWalletHeaders = (wallet: string) => ({ "x-expected-wallet": wallet });
const isSessionBindingError = (error: unknown) => error instanceof ApiError && [401, 403, 409].includes(error.status);

/** The signed-in user's saved Safes. `wallet` only scopes the cache — the list is the session's either way — so a wallet switch never shows the previous account's list. */
export const useSafes = (wallet?: string) => {
  const query = useQuery({
    queryKey: [...safesKey, "list", wallet?.toLowerCase() ?? null] as const,
    enabled: !!wallet,
    queryFn: async () => (await getJson<{ safes: ListedSafe[] }>("/api/safes", { headers: expectedWalletHeaders(wallet!) })).safes,
  });
  return { ...query, data: isSessionBindingError(query.error) ? undefined : query.data };
};

const ownedKey = (wallet: string | undefined) => [...safesKey, "owned", wallet?.toLowerCase() ?? ""] as const;

export type OwnedSafesQuery = {
  /** Rows merged from the networks that answered so far — grows as each request lands; undefined until the first answer. */
  data: FoundSafe[] | undefined;
  /** First load still in flight (some network has not answered yet). */
  isLoading: boolean;
  /** Any network request in flight, including a retry — `data` keeps its rows meanwhile. */
  isFetching: boolean;
  /** No network has succeeded yet; includes disabled, offline, and paused queries. */
  pending: boolean;
  /** Whether any row omits a chain that has not produced a successful response yet. */
  incomplete: boolean;
  /** A scoped endpoint omitted at least one candidate after an ownership or threshold read failed. */
  partial: boolean;
  /** Per-network freshness for any retained row data. */
  freshnessByChainId: Record<number, "fresh" | "stale" | "unavailable">;
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
      queryFn: async () => {
        const response = await getJson<{ safes: FoundSafe[]; partial?: boolean }>(`/api/safes/owned?chainId=${chainId}`, { headers: expectedWalletHeaders(wallet!) });
        return { partial: response.partial === true, safes: response.safes.map(
          (s): OwnedSafeSlice => ({ address: s.address, chainId: s.chainIds[0], threshold: s.threshold, ownerCount: s.ownerCount, owners: s.owners, ...(s.balanceUsd === undefined ? {} : { balanceUsd: s.balanceUsd, assets: s.assets }) }),
        ) };
      },
    })),
    combine: (results): OwnedSafesQuery => {
      const failed = results.filter((r) => r.isError);
      const authError = failed.find((r) => isSessionBindingError(r.error))?.error as Error | undefined;
      const bindingError = authError !== undefined;
      const anyData = results.some((r) => r.data !== undefined);
      const partial = results.some((r) => r.data?.partial === true);
      const freshnessByChainId = Object.fromEntries(DISCOVERY_CHAIN_IDS.map((chainId, i) => {
        const result = results[i];
        return [chainId, result?.isError ? (result.data === undefined ? "unavailable" : "stale") : result?.data !== undefined ? "fresh" : "unavailable"];
      })) as OwnedSafesQuery["freshnessByChainId"];
      const pending = !wallet || bindingError || !anyData;
      return {
        data: bindingError ? undefined : anyData ? mergeOwnedSafeSlices(results.flatMap((r) => r.data?.safes ?? [])) : undefined,
        isLoading: results.some((r) => r.isLoading),
        isFetching: results.some((r) => r.isFetching),
        pending,
        incomplete: pending || failed.length > 0 || results.some((r) => r.isPending) || partial,
        partial,
        freshnessByChainId,
        error: authError ?? (failed[0]?.error as Error | undefined) ?? (partial ? new Error("Some Safes could not be verified. Retry to check again.") : null),
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
