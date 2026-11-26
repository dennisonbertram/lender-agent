"use client";
// Block figures from the server (blocks carry parameters, not figures: architecture section 6).
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/client/http";
import type { AddFundsResponse } from "@/server/blocks/addfunds";
import type { CompareResponse } from "@/server/blocks/compare";
import type { GetCashResponse } from "@/server/blocks/get-cash";
import type { WhatIfResponse } from "@/server/blocks/whatif";
import type { ExplainResponse, ExplainTopic } from "@/server/blocks/explain";
import type { GreetingBlock } from "@/server/blocks/greeting";
import type { HoldingsResponse } from "@/server/blocks/holdings";
import type { StatusResponse } from "@/server/blocks/status";

export type { CompareResponse, GetCashResponse, WhatIfResponse, AddFundsResponse, ExplainResponse, GreetingBlock, HoldingsResponse, StatusResponse };

async function fetchBlock<T>(address: string, path: string): Promise<T> {
  const res = await fetch(`/api/safes/${address}/blocks/${path}`);
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? "Could not load this");
  return res.json();
}

const blockQuery = <T>(address: string, path: string) => ({
  queryKey: ["blocks", address.toLowerCase(), path],
  queryFn: () => fetchBlock<T>(address, path),
  staleTime: 15_000,
});

export const useGreeting = (address: string) => useQuery(blockQuery<GreetingBlock>(address, "greeting"));
export const useStatusBlock = (address: string) => useQuery(blockQuery<StatusResponse>(address, "status"));
export const useHoldingsBlock = (address: string) => useQuery(blockQuery<HoldingsResponse>(address, "holdings"));
export const useAddFundsBlock = (address: string) => useQuery(blockQuery<AddFundsResponse>(address, "addfunds"));
export const useExplainBlock = (address: string, topic: ExplainTopic) => useQuery(blockQuery<ExplainResponse>(address, `explain?topic=${topic}`));

export const useCompareBlock = (address: string, p: { cash: number; asset?: string; network?: string }) =>
  useQuery(blockQuery<CompareResponse>(address, `compare?${new URLSearchParams({ cash: String(p.cash), ...(p.asset ? { asset: p.asset } : {}), ...(p.network ? { network: p.network } : {}) })}`));
export const useWhatIfBlock = (address: string, p: { cash?: number; asset?: string; network?: string }) =>
  useQuery(blockQuery<WhatIfResponse>(address, `whatif?${new URLSearchParams({ ...(p.cash ? { cash: String(p.cash) } : {}), ...(p.asset ? { asset: p.asset } : {}), ...(p.network ? { network: p.network } : {}) })}`));

/** Get cash: `enabled` false until the amount is valid for the screen that needs the choices. `network` picks the source when the server offered more than one. */
export const useGetCash = (address: string, p: { cash?: number; asset?: string; hfIdx?: number; network?: string }) =>
  useQuery({
    queryKey: ["get-cash", address.toLowerCase(), p],
    queryFn: () => fetch(`/api/safes/${address}/get-cash?${new URLSearchParams({ ...(p.cash ? { cash: String(p.cash) } : {}), ...(p.asset ? { asset: p.asset } : {}), ...(p.hfIdx !== undefined ? { hfIdx: String(p.hfIdx) } : {}), ...(p.network ? { network: p.network } : {}) })}`)
      .then(async (res) => { if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? "Could not load this"); return res.json() as Promise<GetCashResponse>; }),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
