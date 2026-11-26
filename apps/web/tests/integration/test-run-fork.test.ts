// BP-13 on a Base fork: the Test run (one eth_call with the helper at the Safe's address) agrees
// with real execution through Safe.execTransaction. Safes are deployed on the fork and funded with
// setBalance (ETH) and a storage write (wstETH, balance mapping at slot 1, found by probing in M0-4).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, parseEther, toHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { dataProviderAbi, erc20Abi } from "@/server/chain/abis";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { setPublicClientForTests } from "@/server/chain/client";
import { readAaveMarket, readAavePosition } from "@/server/chain/reads";
import { testRun } from "@/server/proposals/test-run";
import type { Address } from "@/shared/types";
import type { Spec } from "@/lib/proposals";

const owners = [0, 1].map((i) => privateKeyToAccount(ANVIL_KEYS[i]!).address) as Address[];
const WSTETH = tokenBySymbol(8453, "wstETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;

const open = (asset: "ETH" | "wstETH", amount: number, borrow: number): Spec => ({ kind: "open", venueId: "aave", asset, amount, borrow, safeId: "s", network: "base" });

async function startWithRetries(): Promise<Fork> {
  // The public RPC rate-limits now and then: retry the fork start a few times.
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}

describe("test run on a Base fork", () => {
  let fork: Fork;
  let salt = 100;
  beforeAll(async () => {
    fork = await startWithRetries();
    setPublicClientForTests(8453, fork.publicClient as PublicClient);
  });
  afterAll(async () => {
    setPublicClientForTests(8453, undefined);
    await fork?.stop();
  });

  async function newSafe(threshold: 1 | 2, funds: { eth?: string; wsteth?: bigint } = {}) {
    const d = await deployTestSafe({ fork, owners: threshold === 1 ? [owners[0]!] : owners, threshold, saltNonce: String(salt++) });
    if (funds.eth) await fork.testClient.setBalance({ address: d.address, value: parseEther(funds.eth) });
    if (funds.wsteth) {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [d.address, 1n]));
      await fork.testClient.setStorageAt({ address: WSTETH, index: slot, value: toHex(funds.wsteth, { size: 32 }) });
    }
    return d.address;
  }
  const keys = (n: 1 | 2): Hex[] => ANVIL_KEYS.slice(0, n) as unknown as Hex[];

  it("1-of-1 Safe, ETH collateral: simulated health equals the lender's after execution", async () => {
    const safe = await newSafe(1, { eth: "10" });
    const r = await testRun({ chainId: 8453, safe, spec: open("ETH", 2, 1500), healthBefore: null, atRiskLevel: 1.35 });
    expect(r.ok).toBe(true);
    expect(r.canSend).toBe(true);
    expect(r.steps).toEqual(["Wrap ETH", "Allow Aave v3 to use 2.00 ETH", "Lock 2.00 ETH in Aave v3", "Borrow 1,500 USDC"]);
    expect(r.line).toMatch(/^Checked: this would work\. Network fee about \$/);
    expect(r.feeUsd).toBeGreaterThan(0);
    expect(r.healthAfter).toBeGreaterThan(1);

    const exec = await execSafeTx(fork, safe, r.tx, keys(1));
    expect(exec.success).toBe(true);
    const pos = (await readAavePosition(8453, safe)).position!;
    expect(pos.healthFactor).toBeCloseTo(r.healthAfter!, 4);
    expect(Math.abs(pos.healthFactor - r.healthAfter!) / pos.healthFactor).toBeLessThan(1e-6);
    expect(pos.debt[0]!.amount).toBeCloseTo(1500, 2);
    expect(await fork.publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [safe] })).toBe(1_500_000_000n);
  });

  it("2-of-2 Safe, wstETH collateral: passes, executes, and a close-to-liquidation open says so", async () => {
    const safe = await newSafe(2, { wsteth: parseEther("5") });
    const r = await testRun({ chainId: 8453, safe, spec: open("wstETH", 1, 1000), healthBefore: null, atRiskLevel: 1.35 });
    expect(r.ok).toBe(true);
    expect(r.steps).not.toContain("Wrap ETH");
    expect((await execSafeTx(fork, safe, r.tx, keys(2))).success).toBe(true);
    const pos = (await readAavePosition(8453, safe)).position!;
    expect(Math.abs(pos.healthFactor - r.healthAfter!) / pos.healthFactor).toBeLessThan(1e-6);

    // A tighter second open on the same Safe: health ends between 1.0 and the At-risk level.
    const tight = await testRun({ chainId: 8453, safe, spec: open("wstETH", 1, 2400), healthBefore: pos.healthFactor, atRiskLevel: 1.35 });
    expect(tight.healthAfter!).toBeLessThan(1.35);
    if (tight.healthAfter! >= 1) {
      expect(tight.ok).toBe(true);
      expect(tight.line).toMatch(/^Checked: this would work, but it is close to liquidation\./);
    } else {
      expect(tight.canSend).toBe(false);
    }
  });

  it("a borrow beyond the credit line is blocked with the reason (Aave itself refuses before health could fall below 1.0)", async () => {
    const safe = await newSafe(1, { wsteth: parseEther("5") });
    const r = await testRun({ chainId: 8453, safe, spec: open("wstETH", 1, 3500), healthBefore: null, atRiskLevel: 1.35 });
    expect(r.canSend).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("a borrow above what is allowed fails at the Borrow step, and executing it reverts", async () => {
    const safe = await newSafe(1, { eth: "10" });
    const r = await testRun({ chainId: 8453, safe, spec: open("ETH", 1, 1_000_000), healthBefore: null, atRiskLevel: 1.35 });
    expect(r.ok).toBe(false);
    expect(r.canSend).toBe(false);
    expect(r.failedStep).toBe(3);
    expect(r.steps[r.failedStep!]).toBe("Borrow 1,000,000 USDC");
    expect(r.reason).toContain("Borrow 1,000,000 USDC");
    const exec = await execSafeTx(fork, safe, r.tx, keys(1));
    expect(exec.success).toBe(false);
    expect((await readAavePosition(8453, safe)).position).toBeNull();
  });

  it("a Safe short of funds fails at the first step", async () => {
    const safe = await newSafe(1, { eth: "1" });
    const r = await testRun({ chainId: 8453, safe, spec: open("ETH", 5, 100), healthBefore: null, atRiskLevel: 1.35 });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe(0);
    expect(r.steps[0]).toBe("Wrap ETH");
  });

  it("a protect (repay + add collateral) that raises health but stays below 1.0 can be sent", async () => {
    const safe = await newSafe(1, { eth: "10" });
    const o = await testRun({ chainId: 8453, safe, spec: open("ETH", 2, 1500), healthBefore: null, atRiskLevel: 1.35 });
    expect((await execSafeTx(fork, safe, o.tx, keys(1))).success).toBe(true);
    // A price crash cannot be forced here, so the below-1.0 case is covered in invariants.test.ts;
    // here a high At-risk level exercises the "close to liquidation" line on the health-raising path.
    const before = (await readAavePosition(8453, safe)).position!.healthFactor;
    const spec: Spec = { kind: "protect", loanId: "x", addColl: 0, repay: 500 };
    const r = await testRun({ chainId: 8453, safe, spec, healthBefore: before, atRiskLevel: 100, loan: { collAsset: "ETH", debtAsset: "USDC" } });
    expect(r.ok).toBe(true);
    expect(r.canSend).toBe(true);
    expect(r.healthAfter!).toBeGreaterThan(before);
    expect(r.line).toMatch(/close to liquidation/);
    expect((await execSafeTx(fork, safe, r.tx, keys(1))).success).toBe(true);
  });

  it("a market without the liquidity gives a failed test run, not a passing one", async () => {
    const dp = AAVE[8453]!.dataProvider;
    const [aUsdc] = await fork.publicClient.readContract({ address: dp, abi: dataProviderAbi, functionName: "getReserveTokensAddresses", args: [USDC] });
    // Leave the Pool's USDC reserve with 100 USDC (USDC balance mapping at slot 9).
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [aUsdc, 9n]));
    await fork.testClient.setStorageAt({ address: USDC, index: slot, value: toHex(100_000_000n, { size: 32 }) });
    const market = (await readAaveMarket(8453, USDC)).market;
    expect(market.availableLiquidity).toBe(100);

    const safe = await newSafe(1, { eth: "10" });
    const r = await testRun({ chainId: 8453, safe, spec: open("ETH", 2, 1000), healthBefore: null, atRiskLevel: 1.35 });
    expect(r.ok).toBe(false);
    expect(r.canSend).toBe(false);
    expect(r.failedStep).toBe(3);
    expect((await execSafeTx(fork, safe, r.tx, keys(1))).success).toBe(false);
  });
});
