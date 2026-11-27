// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSession, useSignOut } from "./useSession";

const disconnect = vi.fn();
const replace = vi.fn();
vi.mock("wagmi", () => ({ useAccount: () => ({}), useChainId: () => 1, useSignMessage: () => ({}), useDisconnect: () => ({ disconnect }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
afterEach(cleanup);

describe("useSession freshness", () => {
  it("keeps loading semantics for cached data and marks only the post-mount response fresh", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["session"], null);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.loading).toBe(false);
    expect(result.current.hasFreshSession).toBe(false);
    await waitFor(() => expect(result.current.hasFreshSession).toBe(true));
    expect(result.current.session).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe("useSignOut", () => {
  it("logs out, disconnects, clears the cache and goes to /", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient();
    qc.setQueryData(["safes"], [1]);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSignOut(), { wrapper });
    await act(async () => { await result.current(); });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(disconnect).toHaveBeenCalled();
    expect(qc.getQueryData(["safes"])).toBeUndefined();
    expect(replace).toHaveBeenCalledWith("/");
  });
});
