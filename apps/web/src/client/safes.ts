"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListedSafe } from "@/server/auth/access";
import type { FoundSafe, SafeSummary } from "@/server/safes";

import { ApiError, getJson } from "@/client/http";

export { ApiError };

export const safesKey = ["safes"] as const;
export const safeSummaryKey = (address: string) => ["safes", "summary", address.toLowerCase()] as const;

export const useSafes = () => useQuery({ queryKey: safesKey, queryFn: async () => (await getJson<{ safes: ListedSafe[] }>("/api/safes")).safes });

export const useOwnedSafes = () =>
  useQuery({ queryKey: ["safes", "owned"], queryFn: async () => (await getJson<{ safes: FoundSafe[] }>("/api/safes/owned")).safes });

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
