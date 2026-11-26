"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/client/safes";

/** Ask the agent to draft the close of a loan (BP-26). Returns the new proposal's id; a blocked close carries the sentence to show. */
export function useCloseLoan(address: string, loanId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/safes/${address}/loans/${encodeURIComponent(loanId)}/close`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body?.line ?? body?.error ?? "Something went wrong");
      return body as { proposalId: string };
    },
    onSuccess: () => {
      const a = address.toLowerCase();
      void qc.invalidateQueries({ queryKey: ["loans", a] });
      void qc.invalidateQueries({ queryKey: ["proposals", a] });
    },
  });
}
