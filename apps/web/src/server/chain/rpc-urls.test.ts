import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcRequestError } from "viem";
import { isTerminal } from "./client";
import { rpcUrls } from "./config";

describe("rpcUrls", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses only the configured RPCs, in order, de-duplicated", () => {
    vi.stubEnv("RPC_URL_8453", "https://a.example, https://b.example,https://a.example");
    expect(rpcUrls(8453)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("falls back to the chain's single public default when nothing is configured", () => {
    vi.stubEnv("RPC_URL_8453", "");
    expect(rpcUrls(8453)).toEqual(["https://mainnet.base.org"]);
  });
});

describe("isTerminal", () => {
  const rpc = (code: number, message: string, data?: string) => new RpcRequestError({ body: {}, url: "x", error: { code, message, data } });

  it("stops at a revert, whatever the node calls it", () => {
    expect(isTerminal(rpc(3, "VM execution error.", "0xdeadbeef"))).toBe(true);
    expect(isTerminal(rpc(-32000, "execution reverted"))).toBe(true);
  });

  it("moves on for provider failures", () => {
    expect(isTerminal(rpc(-32005, "rate limited"))).toBe(false);
    expect(isTerminal(new Error("HTTP request failed. Status: 429"))).toBe(false);
  });
});
