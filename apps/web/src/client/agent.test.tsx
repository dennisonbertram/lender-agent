// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAddAgent, useRemoveAgent } from "./agent";

const wallet = vi.hoisted(() => ({ signTypedDataAsync: vi.fn(async () => `0x${"11".repeat(65)}`) }));
vi.mock("wagmi", () => ({ useSignTypedData: () => wallet }));

const agentAddress = "0x00000000000000000000000000000000000000a1";
const signedSafe = "0x00000000000000000000000000000000000000ab";
const status = (added: boolean) => ({
  agentAddress,
  networks: [{ chainId: 42161, deployed: true, added }],
  active: added,
  otherChainIds: [],
  eligibleChainIds: [42161],
  canChat: true,
});
const typedData = {
  chainId: 42161,
  domain: {},
  types: { Delegate: [] },
  primaryType: "Delegate",
  message: { delegateAddress: agentAddress, totp: "1" },
};

function setup(initiallyAdded = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  let added = initiallyAdded;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/agent/typed-data")) return new Response(JSON.stringify(typedData));
    if (url.endsWith("/agent") && init?.method === "POST") { added = true; return new Response(JSON.stringify(status(added))); }
    if (url.endsWith("/agent") && init?.method === "DELETE") { added = false; return new Response(JSON.stringify(status(added))); }
    if (url.endsWith("/agent")) return new Response(JSON.stringify(status(added)));
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { queryClient, fetchMock, wrapper };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); wallet.signTypedDataAsync.mockClear(); });

describe("agent role summary invalidation", () => {
  it("refreshes the Safe summary after a confirmed add", async () => {
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useAddAgent(signedSafe), { wrapper });

    await act(async () => { await result.current.add(42161); });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["safes", "summary", signedSafe.toLowerCase()] });
  });

  it("only signs and adds owned eligible networks for a partially owning wallet", async () => {
    const { fetchMock, wrapper } = setup();
    const partial = {
      ...status(false),
      networks: [
        { chainId: 8453, deployed: true, added: false },
        { chainId: 42161, deployed: true, added: false },
      ],
      eligibleChainIds: [8453],
      canChat: false,
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent/typed-data")) return new Response(JSON.stringify({ ...typedData, chainId: 8453 }));
      if (url.endsWith("/agent") && init?.method === "POST") return new Response(JSON.stringify(partial));
      if (url.endsWith("/agent")) return new Response(JSON.stringify(partial));
      return new Response("{}", { status: 404 });
    });
    const { result } = renderHook(() => useAddAgent(signedSafe), { wrapper });

    await act(async () => { await result.current.add(); });

    expect(wallet.signTypedDataAsync).toHaveBeenCalledTimes(1);
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/agent") && init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({ chainId: 8453 });
  });

  it("rejects an explicitly selected unowned network before asking for a signature", async () => {
    const { fetchMock, wrapper } = setup();
    const partial = {
      ...status(false),
      networks: [
        { chainId: 8453, deployed: true, added: false },
        { chainId: 42161, deployed: true, added: false },
      ],
      eligibleChainIds: [8453],
      canChat: false,
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/agent")) return new Response(JSON.stringify(partial));
      return new Response("{}", { status: 404 });
    });
    const { result } = renderHook(() => useAddAgent(signedSafe), { wrapper });

    await act(async () => {
      await expect(result.current.add(42161)).rejects.toThrow(/not an owner.*Arbitrum.*owns it on Arbitrum/i);
    });

    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/agent") && init?.method === "POST")).toBe(false);
  });

  it("refreshes the Safe summary after a confirmed removal", async () => {
    const { queryClient, wrapper } = setup(true);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRemoveAgent(signedSafe), { wrapper });

    await act(async () => { await result.current.remove(); });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["safes", "summary", signedSafe.toLowerCase()] });
  });
});
