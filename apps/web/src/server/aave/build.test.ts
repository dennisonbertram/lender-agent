import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { AAVE, MULTISEND_CALL_ONLY, tokenBySymbol } from "@/server/chain/config";
import { buildClose, closeAllowanceRaw, buildOpen, buildOuterTx, buildRepay, buildSupplyCollateral } from "./build";

const safe = "0x1111111111111111111111111111111111111111" as const;
const pool = AAVE[8453]!.pool;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const WSTETH = tokenBySymbol(8453, "wstETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;

describe("buildOpen", () => {
  it("ETH plan wraps first, then approves, supplies and borrows", () => {
    const b = buildOpen({ chainId: 8453, safe, collateral: { asset: "ETH", amount: 1.5 }, borrow: { asset: "USDC", amount: 1000 } });
    expect(b.steps).toEqual(["Wrap ETH", "Allow Aave v3 to use 1.50 ETH", "Lock 1.50 ETH in Aave v3", "Borrow 1,000 USDC"]);
    expect(b.calls).toHaveLength(4);
    expect(b.calls[0]).toMatchObject({ to: WETH, value: 1_500_000_000_000_000_000n });
    expect(decodeFunctionData({ abi: wethAbi, data: b.calls[0]!.data }).functionName).toBe("deposit");
    expect(decodeFunctionData({ abi: erc20Abi, data: b.calls[1]!.data }).args).toEqual([pool, 1_500_000_000_000_000_000n]);
    const supply = decodeFunctionData({ abi: poolAbi, data: b.calls[2]!.data });
    expect(supply.functionName).toBe("supply");
    expect(supply.args).toEqual([WETH, 1_500_000_000_000_000_000n, safe, 0]);
    const borrow = decodeFunctionData({ abi: poolAbi, data: b.calls[3]!.data });
    expect(borrow.args).toEqual([USDC, 1_000_000_000n, 2n, 0, safe]);
  });
  it("wstETH plan does not wrap", () => {
    const b = buildOpen({ chainId: 8453, safe, collateral: { asset: "wstETH", amount: 1 }, borrow: { asset: "USDC", amount: 500 } });
    expect(b.steps).not.toContain("Wrap ETH");
    expect(b.calls).toHaveLength(3);
    expect(b.calls.every((c) => c.value === 0n)).toBe(true);
    expect(b.calls[0]!.to).toBe(WSTETH);
  });
  it("rounds the borrow down and the supply up", () => {
    const b = buildOpen({ chainId: 8453, safe, collateral: { asset: "wstETH", amount: 0.0000000000000000011 }, borrow: { asset: "USDC", amount: 10.1234569 } });
    expect(decodeFunctionData({ abi: poolAbi, data: b.calls[1]!.data }).args![1]).toBe(2n);
    expect((decodeFunctionData({ abi: poolAbi, data: b.calls[2]!.data }).args as readonly unknown[])[1]).toBe(10_123_456n);
  });
  it("outer tx is a MultiSendCallOnly delegate call", () => {
    const b = buildOpen({ chainId: 8453, safe, collateral: { asset: "ETH", amount: 1 }, borrow: { asset: "USDC", amount: 100 } });
    const tx = buildOuterTx(b.calls, 7);
    expect(tx.operation).toBe(1);
    expect(tx.to.toLowerCase()).toBe(MULTISEND_CALL_ONLY.toLowerCase());
    expect(tx.nonce).toBe("7");
  });
  it("refuses an unavailable asset and a zero amount", () => {
    expect(() => buildOpen({ chainId: 8453, safe, collateral: { asset: "WBTC" as never, amount: 1 }, borrow: { asset: "USDC", amount: 1 } })).toThrow();
    expect(() => buildOpen({ chainId: 8453, safe, collateral: { asset: "ETH", amount: 1 }, borrow: { asset: "USDC", amount: 0.0000001 } })).toThrow();
  });
});

describe("repay and supply collateral", () => {
  it("repay approves the Pool and repays for the Safe, rounded up", () => {
    const b = buildRepay({ chainId: 8453, safe, asset: "USDC", amount: 500.0000001 });
    expect(b.steps).toEqual(["Allow Aave v3 to use 500 USDC", "Repay 500 USDC on Aave v3"]);
    expect(decodeFunctionData({ abi: poolAbi, data: b.calls[1]!.data }).args).toEqual([USDC, 500_000_001n, 2n, safe]);
  });
  it("keeps cent precision in the owner-visible repayment steps", () => {
    const b = buildRepay({ chainId: 8453, safe, asset: "USDC", amount: 200.25 });
    expect(b.steps).toEqual(["Allow Aave v3 to use 200.25 USDC", "Repay 200.25 USDC on Aave v3"]);
    expect(decodeFunctionData({ abi: poolAbi, data: b.calls[1]!.data }).args).toEqual([USDC, 200_250_000n, 2n, safe]);
  });
  it("supply collateral wraps ETH", () => {
    expect(buildSupplyCollateral({ chainId: 8453, safe, asset: "ETH", amount: 1 }).steps[0]).toBe("Wrap ETH");
    expect(buildSupplyCollateral({ chainId: 8453, safe, asset: "wstETH", amount: 1 }).calls).toHaveLength(2);
  });
});

describe("buildClose", () => {
  const MAX = 2n ** 256n - 1n;
  it("repays with the maximum value (so no debt is left) under an approval sized from the rate and the signing delay, then withdraws all collateral to the Safe", () => {
    const b = buildClose({ chainId: 8453, safe, debt: 5000.123456, apr: 5, collateral: "WETH" });
    expect(b.calls).toHaveLength(4);
    const approve = decodeFunctionData({ abi: erc20Abi, data: b.calls[0]!.data });
    const repay = decodeFunctionData({ abi: poolAbi, data: b.calls[1]!.data });
    expect(decodeFunctionData({ abi: erc20Abi, data: b.calls[2]!.data }).args).toEqual([pool, 0n]);
    const withdraw = decodeFunctionData({ abi: poolAbi, data: b.calls[3]!.data });
    const owed = 5_000_123_456n;
    const allowance = closeAllowanceRaw(owed, 5);
    // 7 days at 5% on ~5,000 USDC is about 4.8 USDC of interest, on top of the 0.1% margin.
    expect(allowance).toBeGreaterThan(owed + owed / 1000n + 4_000_000n);
    expect(allowance).toBeLessThan(owed + owed / 1000n + 6_000_000n);
    expect(approve.args).toEqual([pool, allowance]);
    expect(repay.functionName).toBe("repay");
    expect(repay.args).toEqual([USDC, MAX, 2n, safe]);
    expect(withdraw.functionName).toBe("withdraw");
    expect(withdraw.args).toEqual([WETH, MAX, safe]);
    expect(b.steps).toHaveLength(4);
  });
  it("a higher rate approves more", () => {
    expect(closeAllowanceRaw(1_000_000_000n, 20)).toBeGreaterThan(closeAllowanceRaw(1_000_000_000n, 5));
  });
  it("wstETH loan withdraws wstETH; no debt means no repay", () => {
    const b = buildClose({ chainId: 8453, safe, debt: 0, apr: 5, collateral: "wstETH" });
    expect(b.calls).toHaveLength(1);
    expect((decodeFunctionData({ abi: poolAbi, data: b.calls[0]!.data }).args as readonly unknown[])[0]).toBe(WSTETH);
  });
});
