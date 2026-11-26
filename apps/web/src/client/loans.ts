"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson } from "@/client/http";
import type { LoanDetail, LoansResult } from "@/server/loans";

export type { LoanDetail, LoansResult, LoanView } from "@/server/loans";

export const useLoans = (address: string) =>
  useQuery({ queryKey: ["loans", address.toLowerCase()], refetchInterval: 30_000, queryFn: () => getJson<LoansResult>(`/api/safes/${address}/loans`) });

export const useLoan = (address: string, loanId: string) =>
  useQuery({
    queryKey: ["loans", address.toLowerCase(), loanId],
    refetchInterval: 30_000,
    queryFn: () => getJson<LoanDetail>(`/api/safes/${address}/loans/${encodeURIComponent(loanId)}`),
  });

export type SavedLevels = import("@/server/levels").SavedLevels;

/** Save a loan's alert levels; resolves with the server's "Saved. …" line, rejects with its message. */
export function useSaveLevels(address: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { loanId: string; warn: string; act: string }): Promise<SavedLevels> => {
      const res = await fetch(`/api/safes/${address}/loans/${encodeURIComponent(v.loanId)}/levels`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ warn: v.warn, act: v.act }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not save. Try again.");
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loans", address.toLowerCase()] }),
  });
}
