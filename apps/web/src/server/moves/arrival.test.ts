import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { DEST_TX, SAFE, SRC_TX, STATUS } from "@/server/mock/moves-fixtures/status";
import { followTransfer, MOVE_DELAY_MARGIN_MS, type DestinationChain } from "./arrival";
import { NATIVE, type BridgeAggregator, type TransferStatus } from "./types";
import { statusOf } from "./testing";

const safe = getAddress(SAFE);
const sentAt = Date.parse("2026-11-14T10:00:00Z");
const move = { safe, fromChain: 8453, toChain: 1, sourceTxHash: SRC_TX as `0x${string}`, expectedRaw: 910700000000000n, token: NATIVE, durationSec: 600, sentAt };
const agg = (s: TransferStatus): BridgeAggregator => ({ quote: vi.fn(), status: vi.fn(async () => s) });
const chain = (paid: Awaited<ReturnType<DestinationChain["paysSafe"]>>): DestinationChain & { paysSafe: ReturnType<typeof vi.fn> } => ({ hasCode: async () => true, ownersOf: async () => null, paysSafe: vi.fn(async () => paid) });
const at = (ms: number) => new Date(sentAt + ms);

describe("followTransfer: recorded status sequences (M5 exit 2)", () => {
  it("done: arrived, only once the destination transaction pays the Safe; the amount is what it paid", async () => {
    const c = chain({ ok: true, amountRaw: 910700000000000n });
    const r = await followTransfer({ aggregator: agg(statusOf("done")), chain: c }, move, at(5 * 60_000));
    expect(r).toEqual({ kind: "arrived", amountRaw: 910700000000000n, destTxHash: DEST_TX });
    expect(c.paysSafe).toHaveBeenCalledWith({ chainId: 1, txHash: DEST_TX, safe, token: NATIVE, minRaw: 1n });
  });
  it("done but less than planned: arrived with what arrived", async () => {
    const r = await followTransfer({ aggregator: agg(statusOf("doneLess")), chain: chain({ ok: true, amountRaw: 900000000000000n }) }, move, at(5 * 60_000));
    expect(r).toMatchObject({ kind: "arrived", amountRaw: 900000000000000n });
  });
  it("done, but the destination transaction is not confirmed or does not pay the Safe: not arrived", async () => {
    const r = await followTransfer({ aggregator: agg(statusOf("done")), chain: chain({ ok: false, reason: "no receipt" }) }, move, at(5 * 60_000));
    expect(r).toEqual({ kind: "unconfirmed", reason: "no receipt" });
  });
  it("partial: reported, no arrival", async () => {
    const c = chain({ ok: true, amountRaw: 1n });
    expect(await followTransfer({ aggregator: agg(statusOf("partial")), chain: c }, move, at(60_000))).toMatchObject({ kind: "partial" });
    expect(c.paysSafe).not.toHaveBeenCalled();
  });
  it("refunded: reported with where the funds are", async () => {
    expect(await followTransfer({ aggregator: agg(statusOf("refunded")), chain: chain({ ok: true, amountRaw: 1n }) }, move, at(60_000))).toMatchObject({ kind: "refunded" });
  });
  it("failed: reported", async () => {
    expect(await followTransfer({ aggregator: agg(statusOf("failed")), chain: chain({ ok: true, amountRaw: 1n }) }, move, at(60_000))).toMatchObject({ kind: "failed" });
  });
  it("never found: pending, then delayed once the quoted time plus the margin has passed; never a failure", async () => {
    const a = agg(statusOf("notFound"));
    const c = chain({ ok: true, amountRaw: 1n });
    expect(await followTransfer({ aggregator: a, chain: c }, move, at(10 * 60_000))).toEqual({ kind: "pending" });
    expect(await followTransfer({ aggregator: a, chain: c }, move, at(600_000 + MOVE_DELAY_MARGIN_MS - 1))).toEqual({ kind: "pending" });
    expect(await followTransfer({ aggregator: a, chain: c }, move, at(600_000 + MOVE_DELAY_MARGIN_MS))).toEqual({ kind: "delayed" });
    expect(c.paysSafe).not.toHaveBeenCalled();
  });
  it("pending the whole time (an unrelated deposit of the same asset changes nothing): never arrived", async () => {
    const c = chain({ ok: true, amountRaw: 5n * 10n ** 18n });
    expect(await followTransfer({ aggregator: agg(statusOf("pending")), chain: c }, move, at(2 * 60_000))).toEqual({ kind: "pending" });
    expect(c.paysSafe).not.toHaveBeenCalled(); // no balance or transfer is looked at without the transfer's own status
  });
  it("an aggregator outage is not a verdict", async () => {
    const down: BridgeAggregator = { quote: vi.fn(), status: async () => { throw new Error("502"); } };
    expect(await followTransfer({ aggregator: down, chain: chain({ ok: false, reason: "x" }) }, move, at(1000))).toEqual({ kind: "pending" });
  });
});
