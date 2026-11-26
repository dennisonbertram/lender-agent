"use client";
// Hooks for the plan block (BP-12): the quote, and "Send to Safe".
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuoteInput, QuoteResponse } from "@/server/quote";

export type { QuoteInput, QuoteResponse };

export class QuoteError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: Record<string, unknown>) {
    super(message);
    this.name = "QuoteError";
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new QuoteError(res.status, data?.error ?? "Something went wrong. Try again.", data ?? undefined);
  return data as T;
}

export const quoteKey = (address: string, input: QuoteInput | null) => ["quote", address.toLowerCase(), input] as const;

/** Refetches when the amount, the safety level or any other input changes. A null input means "not valid yet". */
export function useQuote(address: string, input: QuoteInput | null) {
  return useQuery({
    queryKey: quoteKey(address, input),
    queryFn: () => post<QuoteResponse>(`/api/safes/${address}/quote`, input),
    enabled: input !== null,
    staleTime: 15_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

export type SendPlanBody = { draftKey: string; cash: number; asset?: string; network?: string; chainId?: number; venueId?: string; /** The owner picked this lender: the server refuses (409) rather than switch to another. */ venueChosen?: boolean; hfIdx?: number; months?: number; /** The open proposal this edit replaces (BP-24). */ replaces?: string; /** An edit card: the server refuses it when an open proposal exists and `replaces` is missing. */ intent?: "edit" };
export type SendPlanResult = { proposalId: string; stage: string; receipt?: string };

export function useSendPlan(address: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SendPlanBody) => post<SendPlanResult>(`/api/safes/${address}/proposals`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["quote", address.toLowerCase()] });
      window.dispatchEvent(new Event("lender:proposal-sent")); // the chat pulls the new proposal card (BP-15)
    },
    // A refusal (for example "Earlier plan") means the server's draft state moved on: re-read it so the card follows.
    onError: () => void qc.invalidateQueries({ queryKey: ["quote", address.toLowerCase()] }),
  });
}
