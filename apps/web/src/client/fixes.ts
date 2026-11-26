"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FixDraftView, FixOptionKey, FixSendResult, WaitingFix } from "@/server/fixes";
import type { FixOptions } from "@/server/fixes/options";
import type { FixState } from "@/server/fixes/draft";

export type FixPanel = { options: FixOptions | null; state: FixState; draft: FixDraftView | null; safeLink: string | null };
export type { FixDraftView, FixOptionKey, FixOptions, FixState, WaitingFix };

async function json<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.line ?? data?.error ?? fallback);
  return data;
}

export const useFix = (address: string, loanId: string) =>
  useQuery({
    queryKey: ["fixes", address.toLowerCase(), loanId],
    refetchInterval: 30_000,
    queryFn: async () => json<FixPanel>(await fetch(`/api/safes/${address}/fixes?loanId=${encodeURIComponent(loanId)}`), "Could not load the fix options"),
  });

export const useWaitingFixes = (address: string) =>
  useQuery({
    queryKey: ["fixes", address.toLowerCase(), "waiting"],
    refetchInterval: 30_000,
    queryFn: async () => (await json<{ waiting: WaitingFix[] }>(await fetch(`/api/safes/${address}/fixes`), "Could not load fixes")).waiting,
  });

/** Pick an option (a draft, not consent: r30) and send the draft. Both refresh the loan's fix and the loan lists. */
export function useFixActions(address: string, loanId: string) {
  const qc = useQueryClient();
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: ["fixes", address.toLowerCase()] }), qc.invalidateQueries({ queryKey: ["proposals", address.toLowerCase()] })]);
  const pick = useMutation({
    mutationFn: async (option: FixOptionKey) =>
      (await json<{ draft: FixDraftView }>(await fetch(`/api/safes/${address}/fixes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loanId, option }) }), "Could not draft this fix")).draft,
    onSuccess: done,
  });
  const send = useMutation({
    mutationFn: async (draftId: string) => json<FixSendResult>(await fetch(`/api/safes/${address}/fixes/${draftId}/send`, { method: "POST" }), "Could not send this fix"),
    onSuccess: done,
  });
  return { pick, send };
}
