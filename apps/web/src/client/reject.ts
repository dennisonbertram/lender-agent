"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/client/safes";
import type { ProposalView } from "@/server/proposals/view";

/** Reject one proposal; the card is refetched afterwards (the answer already holds the new view). */
export function useRejectProposal(address: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/safes/${address}/proposals/${id}/reject`, { method: "POST" });
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? "Something went wrong");
      return (await res.json()).proposal as ProposalView;
    },
    onSuccess: (proposal) => {
      qc.setQueryData(["proposals", address.toLowerCase(), id], proposal);
      void qc.invalidateQueries({ queryKey: ["proposals", address.toLowerCase()] });
    },
  });
}
