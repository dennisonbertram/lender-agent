import { describe, expect, it } from "vitest";
import { concatHex, encodeFunctionData, encodePacked, parseAbi, size } from "viem";
import { buildSafeTx, multiSendAbi } from "@/server/safe/multisend";
import { AAVE } from "@/server/chain/config";
import { MORPHO_BLUE } from "@/server/lenders/allowlist";
import { MULTISEND_CALL_ONLY } from "@/server/safe/constants";
import { callsOf } from "./calls";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const POOL = AAVE[8453]!.pool;
const SAFE = "0x2222222222222222222222222222222222222222" as const;
const UNKNOWN = "0x3333333333333333333333333333333333333333" as const;
const approve = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [POOL, 5n] });
const supply = encodeFunctionData({ abi: parseAbi(["function supply(address,uint256,address,uint16)"]), args: [WETH, 1n, SAFE, 0] });
const borrow = encodeFunctionData({ abi: parseAbi(["function borrow(address,uint256,uint256,uint16,address)"]), args: [USDC, 1n, 2n, 0, SAFE] });

describe("callsOf", () => {
  it("is one call for a plain transaction", () => {
    const tx = buildSafeTx([{ to: POOL, data: supply }], 1);
    const [c] = callsOf(8453, tx);
    expect(c).toMatchObject({ to: POOL, name: "Aave v3", value: "0", fn: "supply", selector: supply.slice(0, 10) });
  });
  it("decodes every call of a real MultiSend batch", () => {
    const tx = buildSafeTx([{ to: WETH, data: approve }, { to: POOL, data: supply }, { to: POOL, data: borrow }, { to: UNKNOWN, value: 7n }], 1);
    const [outer, ...calls] = callsOf(8453, tx);
    expect(outer).toMatchObject({ to: MULTISEND_CALL_ONLY, name: "MultiSendCallOnly", delegate: true, outer: true });
    expect(calls.map((c) => [c.to, c.name, c.fn])).toEqual([[WETH, "WETH", "approve"], [POOL, "Aave v3", "supply"], [POOL, "Aave v3", "borrow"], [UNKNOWN, null, null]]);
    expect(calls[3]).toMatchObject({ value: "7", selector: null });
  });
  it("names Morpho and leaves unknown selectors as null", () => {
    const tx = buildSafeTx([{ to: MORPHO_BLUE, data: "0xdeadbeef" }, { to: USDC, data: approve }], 1);
    const calls = callsOf(8453, tx).slice(1);
    expect(calls[0]).toMatchObject({ name: "Morpho", fn: null, selector: "0xdeadbeef" });
    expect(calls[1]).toMatchObject({ name: "USDC", fn: "approve" });
  });
  it("keeps the delegatecall outer call, marked unreadable, when the payload does not decode", () => {
    const tx = { ...buildSafeTx([{ to: POOL, data: supply }, { to: POOL, data: borrow }], 1), data: "0x8d80ff0a00" as const };
    const calls = callsOf(8453, tx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: MULTISEND_CALL_ONLY, delegate: true, outer: true, unreadable: true });
  });
  it("shows a delegatecall to any other contract as the outer call, unnamed", () => {
    const tx = { ...buildSafeTx([{ to: POOL, data: supply }, { to: POOL, data: borrow }], 1), to: UNKNOWN };
    const calls = callsOf(8453, tx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: UNKNOWN, name: null, delegate: true, outer: true });
    expect(calls[0]!.unreadable).toBeUndefined();
  });
  it("marks a delegatecall inside a batch, and the plain calls as not", () => {
    // The app's encoder refuses inner delegatecalls, so pack one by hand: a stored transaction is still decoded defensively.
    const packed = concatHex([
      encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, POOL, 0n, BigInt(size(supply)), supply]),
      encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [1, UNKNOWN, 0n, 4n, "0xdeadbeef"]),
    ]);
    const tx = { ...buildSafeTx([{ to: POOL, data: supply }, { to: POOL, data: borrow }], 1), data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] }) };
    const calls = callsOf(8453, tx);
    expect(calls.map((c) => c.delegate)).toEqual([true, false, true]);
  });
});
