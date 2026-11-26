"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuleOption, RulePanelLoan } from "@/server/rules";

async function call(res: Response): Promise<void> {
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not save. Try again.");
}

/** The Safe's loans with their standing rules (BP-25). */
export function useRules(address: string) {
  const qc = useQueryClient();
  const key = ["rules", address.toLowerCase()];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(`/api/safes/${address}/rules`);
      if (!res.ok) throw new Error("Could not read your standing rules.");
      return ((await res.json()) as { loans: RulePanelLoan[] }).loans;
    },
  });
  const url = (loanId: string) => `/api/safes/${address}/loans/${encodeURIComponent(loanId)}/rule`;
  const save = useMutation({
    mutationFn: async (v: { loanId: string; option: RuleOption; enabled: boolean }) =>
      call(await fetch(url(v.loanId), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ option: v.option, enabled: v.enabled }) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: async (loanId: string) => call(await fetch(url(loanId), { method: "DELETE" })),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  return { query, save, remove };
}
