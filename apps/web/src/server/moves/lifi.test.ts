import { describe, expect, it } from "vitest";
import quoteBody from "@/server/mock/moves-fixtures/quote-eth-base-to-ethereum.json";
import { DEST_TX, SAFE, SRC_TX, STATUS } from "@/server/mock/moves-fixtures/status";
import { createLifi, LIFI_DIAMOND } from "./lifi";
import { AggregatorError, NATIVE } from "./types";

const reply = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};
let calls: { url: string; init?: RequestInit }[] = [];
const params = { fromChain: 8453, toChain: 1, fromToken: NATIVE, toToken: NATIVE, fromAmount: 1_000_000_000_000_000n, address: SAFE as `0x${string}` };

describe("LI.FI client: quote", () => {
  it("asks GET /v1/quote with the Safe as sender and recipient and reads the recorded response", async () => {
    calls = [];
    const q = (await createLifi({ fetch: reply(200, quoteBody), apiKey: "k" }).quote(params))!;
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://li.quest/v1/quote");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ fromChain: "8453", toChain: "1", fromAddress: SAFE, toAddress: SAFE, fromAmount: "1000000000000000", slippage: "0.005" });
    expect((calls[0].init?.headers as Record<string, string>)["x-lifi-api-key"]).toBe("k");
    expect(q).toMatchObject({ tool: "layerswap", fromChain: 8453, toChain: 1, toAmount: 915280000000000n, toAmountMin: 910700000000000n, durationSec: 13, fromAddress: SAFE, toAddress: SAFE });
    expect(q.approvalAddress).toBeNull(); // native ETH: no approval
    expect(q.tx).toMatchObject({ to: LIFI_DIAMOND, value: 1_000_000_000_000_000n, chainId: 8453 });
    expect(q.feeUsd).toBeGreaterThan(0);
  });
  it("is null when the aggregator has no route", async () => {
    for (const [status, code] of [[404, 1001], [404, 1002], [422, 1001]] as const) {
      expect(await createLifi({ fetch: reply(status, { message: "None of the available routes", code }) }).quote(params)).toBeNull();
    }
  });
  it("throws when the aggregator cannot answer", async () => {
    await expect(createLifi({ fetch: reply(500, { message: "boom" }) }).quote(params)).rejects.toBeInstanceOf(AggregatorError);
    await expect(createLifi({ fetch: async () => { throw new Error("offline"); } }).quote(params)).rejects.toBeInstanceOf(AggregatorError);
  });
});

describe("LI.FI client: status", () => {
  const st = (body: unknown, http = 200) => createLifi({ fetch: reply(http, body) }).status({ txHash: SRC_TX as `0x${string}`, fromChain: 8453, toChain: 1 });
  it("asks GET /v1/status with the source hash and chains", async () => {
    calls = [];
    await createLifi({ fetch: reply(200, STATUS.pending) }).status({ txHash: SRC_TX as `0x${string}`, fromChain: 8453, toChain: 1, bridge: "relay" });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/status");
    expect(Object.fromEntries(url.searchParams)).toEqual({ txHash: SRC_TX, fromChain: "8453", toChain: "1", bridge: "relay" });
  });
  it("normalises every recorded status", async () => {
    expect(await st(STATUS.done)).toMatchObject({ state: "done", sub: "COMPLETED", receiving: { txHash: DEST_TX, chainId: 1, amount: 910700000000000n, token: NATIVE } });
    expect(await st(STATUS.partial)).toMatchObject({ state: "done", sub: "PARTIAL" });
    expect(await st(STATUS.refunded)).toMatchObject({ state: "done", sub: "REFUNDED" });
    expect(await st(STATUS.failed)).toMatchObject({ state: "failed" });
    expect(await st(STATUS.pending)).toMatchObject({ state: "pending", sub: "WAIT_DESTINATION_TRANSACTION" });
  });
  it("treats NOT_FOUND (200) and code 1003 (404) as not found, never as failure", async () => {
    expect((await st(STATUS.notFound)).state).toBe("not_found");
    expect((await st({ message: "Transaction hash not found", code: 1003 }, 404)).state).toBe("not_found");
  });
  it("throws on a server error", async () => {
    await expect(st({ message: "x" }, 502)).rejects.toBeInstanceOf(AggregatorError);
  });
});
