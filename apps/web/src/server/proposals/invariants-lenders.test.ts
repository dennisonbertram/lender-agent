// Invariants for Compound v3 and Morpho batches (BP-33): the Safe is always the account and the receiver.
import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { adapterFor, COMET_USDC_BASE, MORPHO_WETH_USDC_ID } from "@/server/lenders";
import { cometAbi, morphoAbi } from "@/server/lenders/abis";
import { buildOuterTx } from "@/server/aave/build";
import { tokenBySymbol } from "@/server/chain/config";
import type { Address } from "@/shared/types";
import { checkInvariants } from "./invariants";

const safe = "0x00000000000000000000000000000000000000a1" as Address;
const other = "0x00000000000000000000000000000000000000b2" as Address;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const refs = {
  "compound-v3": { lender: "compound-v3" as const, chainId: 8453 as const, marketId: COMET_USDC_BASE, collateral: "WETH" as const },
  "morpho-blue": { lender: "morpho-blue" as const, chainId: 8453 as const, marketId: MORPHO_WETH_USDC_ID, collateral: "WETH" as const },
};

const check = (calls: ReturnType<typeof buildOuterTx> extends infer _ ? Parameters<typeof buildOuterTx>[0] : never, healthAfter = 1.6) =>
  checkInvariants({ chainId: 8453, safe, calls, outer: buildOuterTx(calls, 0n), risk: "adds", healthBefore: null, healthAfter, simulationOk: true });

describe.each(["compound-v3", "morpho-blue"] as const)("%s open batch", (id) => {
  const built = adapterFor(id).buildOpen({ ref: refs[id], safe, collateral: { asset: "ETH", amount: 2 }, borrow: 3000 });
  it("passes", () => expect(check(built.calls)).toEqual({ ok: true }));
  it("is refused when health after is below 1", () => expect(check(built.calls, 0.9).ok).toBe(false));
});

describe("the Safe must be the account and the receiver", () => {
  it("Compound supplyTo for someone else", () => {
    const c = [{ to: COMET_USDC_BASE as Address, value: 0n, data: encodeFunctionData({ abi: cometAbi, functionName: "supplyTo", args: [other, WETH, 1n] }) }];
    expect(check(c)).toMatchObject({ ok: false, reason: expect.stringMatching(/not the Safe/) });
  });
  it("Morpho borrow paid to someone else", () => {
    const real = adapterFor("morpho-blue").buildBorrow(refs["morpho-blue"], safe, 100).calls[0]!;
    const params = { loanToken: tokenBySymbol(8453, "USDC")!.address!, collateralToken: WETH, oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4" as Address, irm: "0x46415998764C29aB2a25CbeA6254146D50D22687" as Address, lltv: 860000000000000000n };
    const bad = { ...real, data: encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params, 100n, 0n, safe, other] }) };
    expect(check([bad])).toMatchObject({ ok: false });
  });
  it("Morpho market that is not on the allowlist", () => {
    const params = { loanToken: tokenBySymbol(8453, "USDC")!.address!, collateralToken: WETH, oracle: other, irm: other, lltv: 1n };
    const c = [{ to: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address, value: 0n, data: encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params, 100n, 0n, safe, safe] }) }];
    expect(check(c)).toMatchObject({ ok: false, reason: expect.stringMatching(/not on the allowlist/) });
  });
});

describe("Morpho argument positions differ per function", () => {
  const ad = adapterFor("morpho-blue");
  const ref = refs["morpho-blue"];
  const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;
  const params = { loanToken: tokenBySymbol(8453, "USDC")!.address!, collateralToken: WETH, oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4" as Address, irm: "0x46415998764C29aB2a25CbeA6254146D50D22687" as Address, lltv: 860000000000000000n };
  const mk = (functionName: "repay" | "supplyCollateral" | "withdrawCollateral" | "borrow", args: readonly unknown[]) =>
    [{ to: MORPHO, value: 0n, data: encodeFunctionData({ abi: morphoAbi, functionName, args } as never) }];
  const reduces = (calls: Parameters<typeof buildOuterTx>[0]) =>
    checkInvariants({ chainId: 8453, safe, calls, outer: buildOuterTx(calls, 0n), risk: "reduces", healthBefore: 1.5, healthAfter: 2, simulationOk: true });

  it("adapter-built supplyCollateral, borrow, repay (by assets), withdraw all pass", () => {
    expect(check(ad.buildSupply(ref, safe, "WETH", 1).calls)).toEqual({ ok: true });
    expect(check(ad.buildBorrow(ref, safe, 100).calls)).toEqual({ ok: true });
    expect(reduces(ad.buildRepay(ref, safe, 100).calls)).toEqual({ ok: true });
    expect(reduces(ad.buildWithdraw(ref, safe, 1).calls)).toEqual({ ok: true });
  });
  it("a repay by shares (the close shape: assets 0, shares set, onBehalf the Safe) passes", () => {
    expect(reduces(mk("repay", [params, 0n, 12345n, safe, "0x"]))).toEqual({ ok: true });
  });
  it("a wrong onBehalf fails for each function", () => {
    expect(reduces(mk("repay", [params, 0n, 12345n, other, "0x"]))).toMatchObject({ ok: false });
    expect(check(mk("supplyCollateral", [params, 1n, other, "0x"]))).toMatchObject({ ok: false });
    expect(check(mk("withdrawCollateral", [params, 1n, other, safe]))).toMatchObject({ ok: false });
    expect(check(mk("borrow", [params, 1n, 0n, other, safe]))).toMatchObject({ ok: false });
  });
  it("a repay whose shares argument holds an address-like value is judged by the account, not the shares", () => {
    // Shares equal to the Safe's address as an integer must not pass a repay made for someone else.
    expect(reduces(mk("repay", [params, 0n, BigInt(safe), other, "0x"]))).toMatchObject({ ok: false });
  });
});
