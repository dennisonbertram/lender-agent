import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { buildOpen, buildOuterTx, buildRepay, buildSupplyCollateral } from "@/server/aave/build";
import { erc20Abi, poolAbi } from "@/server/chain/abis";
import { AAVE, MULTISEND_CALL_ONLY, tokenBySymbol } from "@/server/chain/config";
import type { Call } from "@/server/safe/multisend";
import { checkInvariants } from "./invariants";

const safe = "0x1111111111111111111111111111111111111111" as const;
const evil = "0x00000000000000000000000000000000000bad01" as const;
const pool = AAVE[8453]!.pool;
const USDC = tokenBySymbol(8453, "USDC")!.address!;
const open = () => buildOpen({ chainId: 8453, safe, collateral: { asset: "wstETH", amount: 1 }, borrow: { asset: "USDC", amount: 1000 } }).calls;

type C = Call & { operation?: number };
const run = (calls: C[], over: Partial<Parameters<typeof checkInvariants>[0]> = {}) =>
  checkInvariants({ chainId: 8453, safe, calls, outer: buildOuterTx(calls, 0), risk: "adds", healthBefore: null, healthAfter: 1.9, simulationOk: true, ...over });
const refused = (r: ReturnType<typeof run>, re: RegExp) => {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(re);
};
/** Replace the last call (the borrow) with `data` on `to`. */
const swapLast = (calls: Call[], to: `0x${string}`, data: `0x${string}`): Call[] => [...calls.slice(0, -1), { to, data }];

describe("checkInvariants", () => {
  it("accepts a normal open", () => expect(run(open())).toEqual({ ok: true }));

  it("refuses a malicious recipient (borrow on behalf of someone else)", () => {
    const data = encodeFunctionData({ abi: poolAbi, functionName: "borrow", args: [USDC, 1n, 2n, 0, evil] });
    refused(run(swapLast(open(), pool, data)), /on behalf of/);
  });
  it("refuses a withdraw paid to someone else, and a transfer out", () => {
    refused(run(swapLast(open(), pool, encodeFunctionData({ abi: poolAbi, functionName: "withdraw", args: [USDC, 1n, evil] }))), /not the Safe/);
    refused(run(swapLast(open(), USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [evil, 1n] }))), /not the Safe/);
  });
  it("refuses a non-allowlisted target", () => {
    refused(run(swapLast(open(), evil, "0x")), /allowlist/);
  });
  it("refuses a wrong onBehalfOf on supply and repay", () => {
    refused(run(swapLast(open(), pool, encodeFunctionData({ abi: poolAbi, functionName: "supply", args: [USDC, 1n, evil, 0] }))), /on behalf of/);
    refused(run(swapLast(open(), pool, encodeFunctionData({ abi: poolAbi, functionName: "repay", args: [USDC, 1n, 2n, evil] }))), /on behalf of/);
  });
  it("refuses an approve to a spender that is not the Pool", () => {
    refused(run(swapLast(open(), USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [evil, 1n] }))), /approves/);
  });
  it("refuses an inner delegatecall", () => {
    const calls: C[] = [...open().slice(0, -1), { to: pool, data: "0x", operation: 1 }];
    refused(checkInvariants({ chainId: 8453, safe, calls, outer: buildOuterTx(open(), 0), risk: "adds", healthBefore: null, healthAfter: 2, simulationOk: true }), /delegate/);
  });
  it("refuses an unknown selector", () => {
    refused(run(swapLast(open(), pool, "0xdeadbeef")), /unknown function/);
    refused(run(swapLast(open(), USDC, "0xdeadbeef")), /unknown function/);
  });
  it("refuses ETH sent to a non-WETH target", () => {
    const calls = open();
    calls[0] = { ...calls[0]!, value: 1n };
    refused(run(calls), /ETH/);
  });
  it("checks the outer transaction", () => {
    const calls = open();
    const outer = buildOuterTx(calls, 0);
    refused(run(calls, { outer: { ...outer, to: evil } }), /MultiSendCallOnly/);
    refused(run(calls, { outer: { ...outer, operation: 0 } }), /exactly one call/);
    refused(run(calls, { outer: { ...outer, refundReceiver: evil } }), /refund/);
    refused(run(calls, { outer: { ...outer, data: buildOuterTx(open().slice(1), 0).data } }), /does not match/);
    expect(outer.to.toLowerCase()).toBe(MULTISEND_CALL_ONLY.toLowerCase());
  });
  it("accepts a single call as a plain transaction", () => {
    const calls = buildSupplyCollateral({ chainId: 8453, safe, asset: "wstETH", amount: 1 }).calls.slice(0, 1);
    expect(run(calls, { risk: "reduces", healthBefore: 0.8, healthAfter: 0.9 })).toEqual({ ok: true });
  });
  it("refuses when the simulation failed", () => refused(run(open(), { simulationOk: false }), /test run failed/));

  describe("health", () => {
    const repay = buildRepay({ chainId: 8453, safe, asset: "USDC", amount: 100 }).calls;
    it("a repay that raises health from 0.80 to 0.95 passes", () => {
      expect(run(repay, { risk: "reduces", healthBefore: 0.8, healthAfter: 0.95 })).toEqual({ ok: true });
    });
    it("a repay that does not raise health fails", () => {
      refused(run(repay, { risk: "reduces", healthBefore: 0.8, healthAfter: 0.8 }), /does not raise/);
    });
    it("a borrow ending at 0.95 fails; exactly 1.0 passes", () => {
      refused(run(open(), { healthAfter: 0.95 }), /below 1\.0/);
      expect(run(open(), { healthAfter: 1.0 })).toEqual({ ok: true });
    });
    it("no debt after (Infinity) passes for reduces", () => {
      expect(run(repay, { risk: "reduces", healthBefore: 1.2, healthAfter: Infinity })).toEqual({ ok: true });
    });
    it("unknown health fails", () => refused(run(open(), { healthAfter: null }), /unknown/));
  });
});
