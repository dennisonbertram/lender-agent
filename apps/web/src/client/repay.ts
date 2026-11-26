"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/client/safes";

export type RepayIntent = { amount: number; idempotencyKey: string; proposalId?: string };

const intentStorageKey = (address: string, loanId: string) => `la:repay-intent:${address.toLowerCase()}:${encodeURIComponent(loanId)}`;

export function readRepayIntent(address: string, loanId: string): RepayIntent | null {
  try {
    const raw = localStorage.getItem(intentStorageKey(address, loanId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RepayIntent>;
    return typeof value.amount === "number" && typeof value.idempotencyKey === "string" ? value as RepayIntent : null;
  } catch { return null; }
}

export function writeRepayIntent(address: string, loanId: string, intent: RepayIntent) {
  try { localStorage.setItem(intentStorageKey(address, loanId), JSON.stringify(intent)); } catch { /* retry still works for this page */ }
}

export function clearRepayIntent(address: string, loanId: string) {
  try { localStorage.removeItem(intentStorageKey(address, loanId)); } catch { /* storage can be disabled */ }
}

export const newRepayIdempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Ask the agent to draft a partial repayment of a loan: the Safe repays the typed USDC amount. Returns the new proposal's id; a blocked repay carries the sentence to show. */
export function useRepayLoan(address: string, loanId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ amount, idempotencyKey }: { amount: number; idempotencyKey?: string }) => {
      const key = idempotencyKey ?? newRepayIdempotencyKey();
      const res = await fetch(`/api/safes/${address}/loans/${encodeURIComponent(loanId)}/repay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, idempotencyKey: key }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body?.line ?? body?.error ?? "Something went wrong", body?.stage);
      return body as { proposalId: string; stage?: string };
    },
    onSuccess: () => {
      const a = address.toLowerCase();
      void qc.invalidateQueries({ queryKey: ["loans", a] });
      void qc.invalidateQueries({ queryKey: ["proposals", a] });
    },
  });
}
