"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/client/safes";
import type { LinkCheck, LinkInput, LinkResult } from "@/server/reserve/link";
import type { ReserveNowBinding, ReserveNowOption, UseNowResult } from "@/server/reserve/executor/use-now";
import type { PolicyChangeInput, PolicyChangeResult, TurnOffResult } from "@/server/reserve/policy-change";
import type { ReserveView } from "@/server/reserve/view";

async function send<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error ?? "Something went wrong");
  return json as T;
}

const POLL_MS = 30_000;
export const reserveKey = (address: string) => ["reserve", address.toLowerCase()] as const;

/** Page, sidebar and chat header all read this one query: one status everywhere (BP-40). */
export const useReserve = (address: string, enabled = true) =>
  useQuery({ queryKey: reserveKey(address), queryFn: () => send<ReserveView>(`/api/safes/${address}/reserve`), refetchInterval: POLL_MS, enabled });

/** Checks of the typed values (balance, field errors, the can/cannot lists). Only runs once a Reserve address is typed. */
export const useReserveCheck = (address: string, input: LinkInput | null) =>
  useQuery({
    queryKey: ["reserve-check", address.toLowerCase(), input],
    queryFn: () => send<LinkCheck>(`/api/safes/${address}/reserve/check`, input),
    enabled: !!input,
    placeholderData: (prev) => prev,
    retry: false,
  });

export function useLinkReserve(address: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkInput) => send<LinkResult>(`/api/safes/${address}/reserve`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: reserveKey(address) }),
  });
}

const json = async (res: Response) => {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "Something went wrong");
  return data;
};

/** The reserve option for one loan: enabled with the dialog title, or disabled with the reason. A 404 means no reserve is linked: the option is not shown. */
export const useReserveNowOption = (address: string, loanId: string) =>
  useQuery({
    queryKey: ["reserve-now", address.toLowerCase(), loanId],
    queryFn: async () => (await json(await fetch(`/api/safes/${address}/reserve/use-now?loanId=${encodeURIComponent(loanId)}`))) as ReserveNowOption,
    retry: false,
  });

export function useUseReserveNow(address: string, loanId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (binding: ReserveNowBinding) => (await json(await fetch(`/api/safes/${address}/reserve/use-now`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loanId, confirm: true, binding }) }))) as UseNowResult,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["reserve-now", address.toLowerCase(), loanId] }); void qc.invalidateQueries({ queryKey: ["alerts"] }); },
    onError: () => void qc.invalidateQueries({ queryKey: ["reserve-now", address.toLowerCase(), loanId] }),
  });
}

export function useTurnReserveOff(address: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (chainId: number = 8453) => (await json(await fetch(`/api/safes/${address}/reserve/off`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId }) }))) as TurnOffResult,
    onSuccess: () => void qc.invalidateQueries({ queryKey: reserveKey(address) }),
  });
}

/** A new limit and/or trigger (text as typed): the Reserve Safe transaction the owners sign. Nothing changes until it executes. */
export function useChangeReservePolicy(address: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PolicyChangeInput) => (await json(await fetch(`/api/safes/${address}/reserve/policy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: 8453, ...input }) }))) as PolicyChangeResult,
    onSuccess: () => void qc.invalidateQueries({ queryKey: reserveKey(address) }),
  });
}
