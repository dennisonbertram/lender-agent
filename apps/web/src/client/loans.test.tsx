// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@/client/http";
import { makeQueryClient } from "@/client/wallet/WalletProvider";
import { useLoan, useLoans } from "./loans";
import { useActivity } from "./activity";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function run<T extends { isError: boolean; error: unknown }>(hook: () => T, status: number) {
  const fetchMock = vi.fn(async () => Response.json({ error: "nope" }, { status }));
  vi.stubGlobal("fetch", fetchMock);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>;
  return { fetchMock, ...renderHook(hook, { wrapper }) };
}

describe("loan and activity reads", () => {
  it("an unknown loan fails at once without retrying", async () => {
    const { result, fetchMock } = run(() => useLoan("0xabc", "nope"), 404);
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(404);
  });
  it("loans and activity throw ApiError and are not retried on a 500", async () => {
    for (const hook of [() => useLoans("0xabc") as { isError: boolean; error: unknown }, () => useActivity("0xabc") as { isError: boolean; error: unknown }]) {
      const { result, fetchMock } = run(hook, 500);
      await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 1000 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBeInstanceOf(ApiError);
      cleanup();
    }
  });
});
