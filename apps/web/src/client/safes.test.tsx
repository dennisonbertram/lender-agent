// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "@/client/wallet/WalletProvider";
import { useOwnedSafes, useSafes, useSafeSummary } from "./safes";

const makeWrapper = () => {
  const client = new QueryClient();
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
// The app's client: transient-only retry, like production.
const appWrapper = () => {
  const client = makeQueryClient();
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
// A plain object, not a Response: its body stream does not settle under fake timers.
const reply = (watching: boolean) => ({ ok: true, json: async () => ({ watching }) }) as unknown as Response;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useSafeSummary polling", () => {
  it("asks again after 15 s while not watching, then only every 60 s once watching", async () => {
    let watching = false;
    const fetchMock = vi.fn(async () => reply(watching));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSafeSummary("0xabc"), { wrapper: makeWrapper() });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.watching).toBe(false);

    watching = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.data?.watching).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2); // watching: no fetch at +15 s
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3); // +60 s after the last fetch
  });
});

const W1 = "0x00000000000000000000000000000000000000a1";
const W2 = "0x00000000000000000000000000000000000000b2";
const SAFE_A = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";

// The per-network rows the owned endpoint returns: a FoundSafe scoped to one chain.
const foundRow = (chainId: number, balanceUsd = 100) => ({
  address: SAFE_A, threshold: 1, ownerCount: 1, chainIds: [chainId], balanceUsd, balanceChainIds: [chainId],
  networkDetails: [{ chainId, threshold: 1, ownerCount: 1, owners: [{ address: W1 }] }], owners: [{ address: W1 }],
});
const ownedOk = (safes: unknown[]) => ({ ok: true, json: async () => ({ safes }) }) as unknown as Response;
const listOk = (safes: unknown[]) => ({ ok: true, json: async () => ({ safes }) }) as unknown as Response;

describe("useOwnedSafes progressive discovery", () => {
  beforeEach(() => vi.useRealTimers());

  it("asks each served network independently and merges rows as they land", async () => {
    const urls: string[] = [];
    let releaseArb!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn((input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("chainId=42161")) return new Promise<Response>((res) => { releaseArb = res; });
      if (url.includes("chainId=8453")) return Promise.resolve(ownedOk([foundRow(8453)]));
      return Promise.resolve(ownedOk([]));
    }));
    const { result } = renderHook(() => useOwnedSafes(W1), { wrapper: appWrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1), { timeout: 1000 });
    for (const id of [8453, 42161]) expect(urls.some((u) => u.includes(`/api/safes/owned?chainId=${id}`))).toBe(true);
    // Base answered, Arbitrum is still out: the row is shown but loading is not done.
    expect(result.current.data?.[0]).toMatchObject({ chainIds: [8453], balanceUsd: 100 });
    expect(result.current.isFetching).toBe(true);
    expect(result.current.isLoading).toBe(true);

    await act(async () => { releaseArb(ownedOk([foundRow(42161, 50)])); });
    await waitFor(() => expect(result.current.isFetching).toBe(false), { timeout: 1000 });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.[0]).toMatchObject({ chainIds: [8453, 42161], balanceUsd: 150, balanceChainIds: [8453, 42161] });
    expect(result.current.data?.[0].networkDetails?.map((d: { chainId: number }) => d.chainId)).toEqual([8453, 42161]);
  });

  it("never shows another wallet's Safes: the cache is scoped to the wallet", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input) => { urls.push(String(input)); return Promise.resolve(ownedOk([foundRow(8453)])); }));
    const { result, rerender } = renderHook(({ w }) => useOwnedSafes(w), { wrapper: appWrapper(), initialProps: { w: W1 } });
    await waitFor(() => expect(result.current.data).toHaveLength(1), { timeout: 1000 });
    rerender({ w: W2 });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 1000 });
    expect(urls.filter((u) => u.includes("chainId=8453"))).toHaveLength(2);
  });

  it("keeps the networks that answered when one fails, and retries only the failed one", async () => {
    const counts = { base: 0, arb: 0 };
    let arbDown = true;
    vi.stubGlobal("fetch", vi.fn((input) => {
      const url = String(input);
      if (url.includes("chainId=42161")) {
        counts.arb += 1;
        return arbDown ? Promise.resolve(Response.json({ error: "down" }, { status: 500 })) : Promise.resolve(ownedOk([foundRow(42161, 50)]));
      }
      counts.base += 1;
      return Promise.resolve(ownedOk([foundRow(8453)]));
    }));
    const { result } = renderHook(() => useOwnedSafes(W1), { wrapper: appWrapper() });
    await waitFor(() => expect(result.current.error).toBeTruthy(), { timeout: 1000 });
    expect(result.current.data).toHaveLength(1); // Base's Safe is still shown, no false empty
    expect(result.current.data?.[0].chainIds).toEqual([8453]);
    expect(result.current.failedChainIds).toEqual([42161]);

    arbDown = false;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.error).toBeNull(), { timeout: 1000 });
    expect(result.current.data?.[0]).toMatchObject({ chainIds: [8453, 42161], balanceUsd: 150 });
    expect(counts).toEqual({ base: 1, arb: 2 }); // the healthy network was not asked again
  });

  it("does not clear found Safes when a background refetch fails", async () => {
    let down = false;
    vi.stubGlobal("fetch", vi.fn((input) => {
      const url = String(input);
      if (down) return Promise.resolve(Response.json({ error: "down" }, { status: 500 }));
      return Promise.resolve(ownedOk([foundRow(url.includes("chainId=42161") ? 42161 : 8453, 50)]));
    }));
    const { result } = renderHook(() => useOwnedSafes(W1), { wrapper: appWrapper() });
    await waitFor(() => expect(result.current.data?.[0]?.chainIds).toEqual([8453, 42161]), { timeout: 1000 });
    down = true;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.error).toBeTruthy(), { timeout: 1000 });
    expect(result.current.data?.[0].chainIds).toEqual([8453, 42161]);
  });
});

describe("useSafes wallet scoping", () => {
  beforeEach(() => vi.useRealTimers());

  it("refetches for a different wallet instead of reusing the previous wallet's saved list", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input) => { seen.push(String(input)); return Promise.resolve(listOk([{ address: `0x${seen.length}` }])); }));
    const { result, rerender } = renderHook(({ w }) => useSafes(w), { wrapper: appWrapper(), initialProps: { w: W1 } });
    await waitFor(() => expect(result.current.data).toHaveLength(1), { timeout: 1000 });
    rerender({ w: W2 });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.[0]).toMatchObject({ address: "0x2" }), { timeout: 1000 });
    expect(seen.filter((u) => u === "/api/safes")).toHaveLength(2);
  });
});
