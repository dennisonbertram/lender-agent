// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSignOut } from "./useSession";

const disconnect = vi.fn();
const replace = vi.fn();
vi.mock("wagmi", () => ({ useAccount: () => ({}), useChainId: () => 1, useSignMessage: () => ({}), useDisconnect: () => ({ disconnect }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
afterEach(cleanup);

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
