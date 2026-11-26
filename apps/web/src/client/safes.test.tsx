// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSafeSummary } from "./safes";

const makeWrapper = () => {
  const client = new QueryClient();
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
