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
const KNOWN_SAFE_LIMIT = 64;

type OwnedChainData = {
  safes: OwnedSafeSlice[];
  partial: boolean;
  streaming: boolean;
  ownershipStaleAddresses: string[];
  ownershipPendingAddresses: string[];
  balanceStaleAddresses: string[];
  balancePendingAddresses: string[];
};

const asOwnedSlice = (safe: FoundSafe): OwnedSafeSlice => ({
  address: safe.address,
  chainId: safe.chainIds[0],
  threshold: safe.threshold,
  ownerCount: safe.ownerCount,
  owners: safe.owners,
  ...(safe.balanceUsd === undefined ? {} : { balanceUsd: safe.balanceUsd, assets: safe.assets }),
});

const decodeStreamSafe = (value: unknown): OwnedSafeSlice => {
  if (!value || typeof value !== "object" || !("address" in value) || typeof value.address !== "string" || !Array.isArray((value as FoundSafe).chainIds)) throw new Error("Invalid Safe discovery event.");
  return asOwnedSlice(value as FoundSafe);
};

const responseError = async (response: Response) => {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new ApiError(response.status, typeof body?.error === "string" ? body.error : "Something went wrong");
};

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
  /** Previously verified ownership rows awaiting a result, keyed by chain ID. */
  ownershipPendingByChainId: Record<number, string[]>;
  /** Rows kept after ownership could not be checked, keyed by chain ID. */
  ownershipStaleByChainId: Record<number, string[]>;
  /** Verified ownership rows whose balance/name enrichment is still running. */
  balancePendingAddresses: string[];
  /** Last known balances whose current enrichment failed or was interrupted, keyed by chain ID. */
  balanceStaleByChainId: Record<number, string[]>;
  /** Aggregate compatibility aliases for row status. */
  pendingAddresses: string[];
  staleAddresses: string[];
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
  const queryClient = useQueryClient();
  return useQueries({
    queries: DISCOVERY_CHAIN_IDS.map((chainId) => ({
      queryKey: [...ownedKey(wallet), chainId] as const,
      enabled: !!wallet,
      queryFn: async ({ signal }) => {
        const queryKey = [...ownedKey(wallet), chainId] as const;
        const previous = queryClient.getQueryData<OwnedChainData>(queryKey);
        const previousRows = previous?.safes ?? [];
        const known = previousRows.slice(0, KNOWN_SAFE_LIMIT).map((safe) => safe.address);
        const headers = new Headers({ ...expectedWalletHeaders(wallet!), accept: "application/x-ndjson" });
        if (known.length) headers.set("x-known-safes", known.join(","));
        const response = await fetch(`/api/safes/owned?chainId=${chainId}`, { headers, signal });
        if (!response.ok) throw await responseError(response);
        if (!response.headers?.get("content-type")?.toLowerCase().includes("application/x-ndjson")) {
          const body = await response.json() as { safes: FoundSafe[]; partial?: boolean; indeterminateAddresses?: string[]; notOwnedAddresses?: string[]; removedAddresses?: string[] };
          const fresh = body.safes.map(asOwnedSlice);
          const freshKeys = new Set(fresh.map((safe) => safe.address.toLowerCase()));
          const removed = new Set([...(body.notOwnedAddresses ?? []), ...(body.removedAddresses ?? [])].map((a) => a.toLowerCase()));
          const indeterminate = new Set((body.indeterminateAddresses ?? []).map((a) => a.toLowerCase()));
          const hasDispositions = Array.isArray(body.indeterminateAddresses) && Array.isArray(body.notOwnedAddresses) && Array.isArray(body.removedAddresses);
          const sentKnown = new Set(known.map((address) => address.toLowerCase()));
          const stale = previousRows.filter((safe) => {
            const address = safe.address.toLowerCase();
            if (freshKeys.has(address) || removed.has(address)) return false;
            return indeterminate.has(address) || body.partial === true && !hasDispositions && sentKnown.has(address);
          }).map((safe) => safe.address);
          const byAddress = new Map([...previousRows.filter((safe) => stale.some((a) => a.toLowerCase() === safe.address.toLowerCase())).map((safe) => [safe.address.toLowerCase(), safe] as const), ...fresh.map((safe) => [safe.address.toLowerCase(), safe] as const)]);
          const staleWithBalance = previousRows.filter((safe) => safe.balanceUsd !== undefined && stale.some((address) => address.toLowerCase() === safe.address.toLowerCase())).map((safe) => safe.address);
          return { safes: [...byAddress.values()], partial: body.partial === true, streaming: false, ownershipStaleAddresses: stale, ownershipPendingAddresses: [], balanceStaleAddresses: staleWithBalance, balancePendingAddresses: [] };
        }

        const baseline = new Map(previousRows.map((safe) => [safe.address.toLowerCase(), safe]));
        const current = new Map(baseline);
        const knownSet = new Set(known.map((address) => address.toLowerCase()));
        const ownershipPending = new Set(baseline.keys());
        const ownershipStale = new Set<string>();
        const balancePending = new Set<string>();
        const balanceStale = new Set<string>();
        let partial = false;
        let streaming = true;
        const update = () => queryClient.setQueryData<OwnedChainData>(queryKey, {
          safes: [...current.values()], partial, streaming,
          ownershipStaleAddresses: [...ownershipStale].map((address) => current.get(address)?.address ?? address),
          ownershipPendingAddresses: [...ownershipPending].map((address) => current.get(address)?.address ?? address),
          balanceStaleAddresses: [...balanceStale].map((address) => current.get(address)?.address ?? address),
          balancePendingAddresses: [...balancePending].map((address) => current.get(address)?.address ?? address),
        });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          if (!response.body) throw new Error("Safe discovery stream was empty.");
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let started = false;
          let finished = false;
          update();
          while (true) {
            const chunk = await reader.read();
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
              if (!line) continue;
              const event = JSON.parse(line) as { type?: string; safe?: unknown; address?: string; status?: string; partial?: boolean; complete?: boolean };
              if (finished) throw new Error("Safe discovery sent data after completion.");
              if (event.type === "start") { started = true; continue; }
              if (!started) throw new Error("Safe discovery stream did not start correctly.");
              if (event.type === "error") throw new Error("Safe discovery could not finish. Retry to check again.");
              if (event.type === "candidate") {
                if (event.safe) {
                  const safe = decodeStreamSafe(event.safe);
                  const key = safe.address.toLowerCase();
                  const previous = current.get(key);
                  const hasBalance = safe.balanceUsd !== undefined;
                  const merged = hasBalance || !previous || previous.balanceUsd === undefined ? safe : { ...safe, balanceUsd: previous.balanceUsd, ...(previous.assets ? { assets: previous.assets } : {}) };
                  current.set(key, merged);
                  ownershipPending.delete(key);
                  ownershipStale.delete(key);
                  if (event.complete) {
                    balancePending.delete(key);
                    if (hasBalance) balanceStale.delete(key);
                    else if (previous?.balanceUsd !== undefined) balanceStale.add(key);
                  } else balancePending.add(key);
                } else if (event.address && ["not-owned", "removed"].includes(event.status ?? "")) {
                  const key = event.address.toLowerCase();
                  current.delete(key);
                  ownershipPending.delete(key);
                  ownershipStale.delete(key);
                  balancePending.delete(key);
                  balanceStale.delete(key);
                } else if (event.address && event.status === "indeterminate") {
                  const key = event.address.toLowerCase();
                  ownershipPending.delete(key);
                  balancePending.delete(key);
                  if (current.has(key)) {
                    ownershipStale.add(key);
                    if (current.get(key)?.balanceUsd !== undefined) balanceStale.add(key);
                  }
                } else throw new Error("Invalid Safe discovery candidate event.");
                update();
                continue;
              }
              if (event.type === "done") {
                finished = true;
                streaming = false;
                partial = event.partial === true;
                if (partial) {
                  for (const address of ownershipPending) {
                    if (current.has(address) && knownSet.has(address)) {
                      ownershipStale.add(address);
                      if (current.get(address)?.balanceUsd !== undefined) balanceStale.add(address);
                    }
                    else current.delete(address);
                  }
                  for (const address of balancePending) if (current.has(address) && current.get(address)?.balanceUsd !== undefined) balanceStale.add(address);
                } else {
                  for (const address of ownershipPending) current.delete(address);
                  for (const address of balancePending) if (current.has(address) && current.get(address)?.balanceUsd !== undefined) balanceStale.add(address);
                }
                ownershipPending.clear();
                balancePending.clear();
                update();
                continue;
              }
              throw new Error("Unknown Safe discovery event.");
            }
            if (chunk.done) break;
          }
          if (buffer.trim() || !started || !finished) throw new Error("Safe discovery stream was truncated. Retry to check again.");
          return { safes: [...current.values()], partial, streaming: false,
            ownershipStaleAddresses: [...ownershipStale].map((address) => current.get(address)?.address ?? address), ownershipPendingAddresses: [],
            balanceStaleAddresses: [...balanceStale].map((address) => current.get(address)?.address ?? address), balancePendingAddresses: [...balancePending].map((address) => current.get(address)?.address ?? address) };
        } catch (error) {
          for (const address of ownershipPending) if (current.has(address)) {
            ownershipStale.add(address);
          }
          ownershipPending.clear();
          for (const address of balancePending) if (current.has(address) && current.get(address)?.balanceUsd !== undefined) balanceStale.add(address);
          balancePending.clear();
          partial = true;
          streaming = false;
          update();
          await reader?.cancel().catch(() => undefined);
          throw error;
        } finally {
          reader?.releaseLock();
        }
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
      const ownershipPendingByChainId = Object.fromEntries(DISCOVERY_CHAIN_IDS.map((chainId, i) => [chainId, results[i]?.data?.ownershipPendingAddresses ?? []]));
      const ownershipStaleByChainId = Object.fromEntries(DISCOVERY_CHAIN_IDS.map((chainId, i) => {
        const result = results[i];
        const stale = new Set(result?.data?.ownershipStaleAddresses ?? []);
        if (result?.isError) for (const safe of result.data?.safes ?? []) stale.add(safe.address);
        return [chainId, [...stale]];
      }));
      const balanceStaleByChainId = Object.fromEntries(DISCOVERY_CHAIN_IDS.map((chainId, i) => {
        const result = results[i];
        const stale = new Set(result?.data?.balanceStaleAddresses ?? []);
        if (result?.isError) for (const safe of result.data?.safes ?? []) if (safe.balanceUsd !== undefined) stale.add(safe.address);
        return [chainId, [...stale]];
      }));
      const balancePendingAddresses = [...new Set(results.flatMap((r) => r.data?.balancePendingAddresses ?? []))];
      const ownershipPendingAddresses = [...new Set(Object.values(ownershipPendingByChainId).flat())];
      const ownershipStaleAddresses = [...new Set(Object.values(ownershipStaleByChainId).flat())];
      const staleAddresses = [...new Set([...ownershipStaleAddresses, ...Object.values(balanceStaleByChainId).flat()])];
      const pendingAddresses = [...new Set([...ownershipPendingAddresses, ...balancePendingAddresses])];
      const pending = !wallet || bindingError || !anyData || results.some((r) => r.data?.streaming && r.data.safes.length === 0);
      return {
        data: bindingError ? undefined : anyData ? mergeOwnedSafeSlices(results.flatMap((r) => r.data?.safes ?? [])) : undefined,
        isLoading: results.some((r) => r.isLoading),
        isFetching: results.some((r) => r.isFetching),
        pending,
        incomplete: pending || failed.length > 0 || results.some((r) => r.isPending || r.data?.streaming) || partial || pendingAddresses.length > 0,
        partial,
        freshnessByChainId,
        ownershipPendingByChainId,
        ownershipStaleByChainId,
        balancePendingAddresses,
        balanceStaleByChainId,
        staleAddresses,
        pendingAddresses,
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
