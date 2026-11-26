// BP-32 adapter contract suite (test-plan layer 2, "per lender adapter") on the pinned Base fork,
// run for every adapter in the allowlist. Numbering follows test-plan.md items 1-10.
// Item 2 ("simulation equals execution") runs the app's own Test run simulator (simulateBatch) on the
// batch and compares it with the real Safe execution of the same batch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { setPublicClientForTests } from "@/server/chain/client";
import { erc20Abi, poolAbi, oracleAbi, wethAbi } from "@/server/chain/abis";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { buildOuterTx } from "@/server/aave/build";
import { simulateBatch } from "@/server/simulate";
import type { Call } from "@/server/safe/multisend";
import { ADAPTERS, canOpen, offeredMarkets, planAvailable, COMET_USDC_BASE, MORPHO_BLUE, cometAbi, morphoAbi, type LenderAdapter, type MarketRef } from "@/server/lenders";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { stubReturning, setUsdc } from "../helpers/oracle";
import { deployTestSafe, execSafeTx, safeAbi } from "../helpers/safe";

const WETH = tokenBySymbol(8453, "WETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;
const aave = AAVE[8453]!;
const ownerKey = ANVIL_KEYS[1];
const owner = privateKeyToAccount(ownerKey).address as Address;
const liquidator = privateKeyToAccount(ANVIL_KEYS[3]);
const thirdParty = privateKeyToAccount(ANVIL_KEYS[2]);

const aaveExtra = parseAbi([
  "function getSourceOfAsset(address) view returns (address)",
  "function liquidationCall(address collateral, address debt, address user, uint256 debtToCover, bool receiveAToken)",
]);

let fork: Fork;
let saltCounter = 100;

/** What the suite needs from each lender that the adapter itself does not expose. */
type Harness = {
  ref: MarketRef;
  /** The lender's own health and liquidatable flag, read straight from its contracts. */
  own(safe: Address): Promise<{ health: number | null; liquidatable: boolean }>;
  /** Multiply the collateral price the lender uses by `f` (by replacing its price source). */
  setPrice(f: number): Promise<void>;
  /** The lender's own liquidation call, sent by a liquidator. Throws when it reverts. */
  liquidate(safe: Address): Promise<void>;
  /** Give the Safe something besides the plan's own pair. null when the lender cannot hold it (Morpho). */
  addForeign: ((safe: Address) => Promise<void>) | null;
  /** Leave the lender with 100 USDC to lend. */
  drainLiquidity(): Promise<void>;
};

const send = async (account: typeof thirdParty, to: Address, data: Hex, value = 0n) => {
  const hash = await fork.walletClient.sendTransaction({ account, chain: fork.chain, to, data, value, gas: 3_000_000n });
  const r = await fork.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${to}`);
};

const mulF = (p: bigint, f: number) => (p * BigInt(Math.round(f * 1e6))) / 1_000_000n;

function aaveHarness(): Harness {
  return {
    ref: { lender: "aave-v3", chainId: 8453, marketId: aave.pool, collateral: "WETH" },
    async own(safe) {
      const a = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [safe] });
      return a[1] === 0n ? { health: null, liquidatable: false } : { health: Number(a[5]) / 1e18, liquidatable: a[5] < 10n ** 18n };
    },
    async setPrice(f) {
      const price = await fork.publicClient.readContract({ address: aave.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [WETH] });
      const source = await fork.publicClient.readContract({ address: aave.oracle, abi: aaveExtra, functionName: "getSourceOfAsset", args: [WETH] });
      await stubReturning(fork, source, [mulF(price, f)]);
    },
    async liquidate(safe) {
      await setUsdc(fork, liquidator.address, 1_000_000_000n);
      await send(liquidator, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [aave.pool, 2n ** 255n] }));
      await send(liquidator, aave.pool, encodeFunctionData({ abi: aaveExtra, functionName: "liquidationCall", args: [WETH, USDC, safe, 100_000_000n, false] }));
    },
    async addForeign(safe) {
      // USDC supplied as collateral next to WETH: the account is no longer the plan's own pair.
      await setUsdc(fork, safe, 1_000_000_000n);
      await asSafe(safe, [
        { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [aave.pool, 100_000_000n] }) },
        { to: aave.pool, data: encodeFunctionData({ abi: poolAbi, functionName: "supply", args: [USDC, 100_000_000n, safe, 0] }) },
      ]);
    },
    async drainLiquidity() {
      const dp = parseAbi(["function getReserveTokensAddresses(address) view returns (address,address,address)"]);
      const [aUsdc] = await fork.publicClient.readContract({ address: aave.dataProvider, abi: dp, functionName: "getReserveTokensAddresses", args: [USDC] });
      await setUsdc(fork, aUsdc, 100_000_000n);
    },
  };
}

function compoundHarness(): Harness {
  const feedAbi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
  return {
    ref: { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" },
    async own(safe) {
      const [liq, debt, coll, info] = await Promise.all([
        fork.publicClient.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "isLiquidatable", args: [safe] }),
        fork.publicClient.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "borrowBalanceOf", args: [safe] }),
        fork.publicClient.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "userCollateral", args: [safe, WETH] }),
        fork.publicClient.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "getAssetInfoByAddress", args: [WETH] }),
      ]);
      if (debt === 0n) return { health: null, liquidatable: liq };
      const price = await fork.publicClient.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "getPrice", args: [info.priceFeed] });
      const collUsd = (Number(coll[0]) / 1e18) * (Number(price) / 1e8) * (Number(info.liquidateCollateralFactor) / 1e18);
      return { health: collUsd / (Number(debt) / 1e6), liquidatable: liq };
    },
    async setPrice(f) {
      const info = await fork.publicClient.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "getAssetInfoByAddress", args: [WETH] });
      const [, answer] = await fork.publicClient.readContract({ address: info.priceFeed, abi: feedAbi, functionName: "latestRoundData" });
      await stubReturning(fork, info.priceFeed, [1n, mulF(answer, f), 0n, 0n, 1n]);
    },
    async liquidate(safe) {
      await send(liquidator, COMET_USDC_BASE, encodeFunctionData({ abi: cometAbi, functionName: "absorb", args: [liquidator.address, [safe]] }));
    },
    async addForeign(safe) {
      // wstETH collateral next to WETH: the account is no longer the plan's own pair.
      const wst = tokenBySymbol(8453, "wstETH")!.address!;
      const slot = await findBalanceSlot(wst);
      await fork.testClient.setStorageAt({ address: wst, index: slot(safe), value: `0x${(10n ** 18n).toString(16).padStart(64, "0")}` });
      await asSafe(safe, [
        { to: wst, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [COMET_USDC_BASE, 10n ** 18n] }) },
        { to: COMET_USDC_BASE, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [wst, 10n ** 18n] }) },
      ]);
    },
    async drainLiquidity() {
      await setUsdc(fork, COMET_USDC_BASE, 100_000_000n);
    },
  };
}

const MORPHO_ID = "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda" as Hex;
const WAD = 10n ** 18n;

function morphoHarness(): Harness & { params(): Promise<{ loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }> } {
  const params = async () => {
    const [loanToken, collateralToken, oracle, irm, lltv] = await fork.publicClient.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "idToMarketParams", args: [MORPHO_ID] });
    return { loanToken, collateralToken, oracle, irm, lltv };
  };
  return {
    params,
    ref: { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_ID, collateral: "WETH" },
    async own(safe) {
      const p = await params();
      const [pos, mkt, price] = await Promise.all([
        fork.publicClient.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "position", args: [MORPHO_ID, safe] }),
        fork.publicClient.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [MORPHO_ID] }),
        fork.publicClient.readContract({ address: p.oracle, abi: parseAbi(["function price() view returns (uint256)"]), functionName: "price" }),
      ]);
      const borrowed = (pos[1] * (mkt[2] + 1n) + (mkt[3] + 1_000_000n) - 1n) / (mkt[3] + 1_000_000n);
      if (pos[1] === 0n) return { health: null, liquidatable: false };
      const maxBorrow = (((pos[2] * price) / 10n ** 36n) * p.lltv) / WAD;
      return { health: Number(maxBorrow) / Number(borrowed), liquidatable: borrowed > maxBorrow };
    },
    async setPrice(f) {
      const p = await params();
      const price = await fork.publicClient.readContract({ address: p.oracle, abi: parseAbi(["function price() view returns (uint256)"]), functionName: "price" });
      await stubReturning(fork, p.oracle, [mulF(price, f)]);
    },
    async liquidate(safe) {
      const p = await params();
      await setUsdc(fork, liquidator.address, 1_000_000_000n);
      await send(liquidator, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO_BLUE, 2n ** 255n] }));
      await send(liquidator, MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "liquidate", args: [p, safe, 10n ** 15n, 0n, "0x"] }));
    },
    addForeign: null, // a Morpho position is one isolated market: it cannot hold another asset
    async drainLiquidity() {
      await setUsdc(fork, MORPHO_BLUE, 100_000_000n);
    },
  };
}

async function newSafe(): Promise<Address> {
  const { address } = await deployTestSafe({ fork, owners: [owner], threshold: 1, saltNonce: String(saltCounter++) });
  await fork.testClient.setBalance({ address, value: parseEther("20") });
  await setUsdc(fork, address, 50_000_000n); // a little USDC for interest at close
  return address;
}

async function execute(safe: Address, calls: Call[]) {
  const nonce = await fork.publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const r = await execSafeTx(fork, safe, buildOuterTx(calls, nonce), [ownerKey]);
  return r.success;
}
async function asSafe(safe: Address, calls: Call[]) {
  if (!(await execute(safe, calls))) throw new Error("setup transaction failed");
}

const snapshot = () => fork.testClient.snapshot();
const revert = (id: Hex) => fork.testClient.revert({ id });

beforeAll(async () => {
  fork = await startBaseFork();
  setPublicClientForTests(8453, fork.publicClient as never);
}, 240_000);
afterAll(async () => {
  setPublicClientForTests(8453, undefined);
  await fork?.stop();
});

const harnesses: [string, () => Harness][] = [
  ["aave-v3", aaveHarness],
  ["compound-v3", compoundHarness],
  ["morpho-blue", morphoHarness],
];

describe("allowlist rows are the ones the suite covers", () => {
  it("every offered Base market has a harness below", () => {
    expect(offeredMarkets(8453).map((m) => m.lender).sort()).toEqual(harnesses.map(([id]) => id).sort());
  });
});

describe.each(harnesses)("adapter contract: %s on the Base fork", (id, make) => {
  const h = make();
  const adapter: LenderAdapter = ADAPTERS[id as keyof typeof ADAPTERS];
  const AMOUNT = 2;

  /** Borrow that gives about `target` health, from the lender's own thresholds. */
  async function borrowFor(target: number) {
    const m = await adapter.readMarket(h.ref);
    return { m, borrow: Math.floor((AMOUNT * m.collateralPriceUsd * m.liquidationThreshold) / target) };
  }
  const open = (safe: Address, borrow: number) => adapter.buildOpen({ ref: h.ref, safe, collateral: { asset: "ETH", amount: AMOUNT }, borrow });
  const near = (a: number | null, b: number | null, rel = 0.005) => {
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs(a! - b!) / b!).toBeLessThan(rel);
  };

  it("1. buildOpen creates the position and the predicted health equals the lender's own", async () => {
    const safe = await newSafe();
    const { m, borrow } = await borrowFor(1.6);
    expect(await execute(safe, open(safe, borrow).calls)).toBe(true);
    const pos = (await adapter.readPosition(h.ref, safe))!;
    const own = await h.own(safe);
    const predicted = (AMOUNT * m.collateralPriceUsd * m.liquidationThreshold) / borrow;
    near(predicted, own.health);
    near(pos.health, own.health, 0.001);
    expect(pos.liquidatable).toBe(false);
    expect(own.liquidatable).toBe(false);
    expect(pos.collateral[0]!.amount).toBeCloseTo(AMOUNT, 6);
    expect(pos.debt[0]!.amount).toBeCloseTo(borrow, 1);
    expect(pos.mixed).toBe(false);
  });

  it("2. the app's Test run (simulateBatch) gives the same result as the real run", async () => {
    const safe = await newSafe();
    const { borrow } = await borrowFor(1.6);
    const built = open(safe, borrow);
    const venue = id === "aave-v3" ? "aave" : "generic";
    const sim = await simulateBatch({ client: fork.publicClient as never, chainId: 8453, safe, calls: built.calls, venue });
    expect(sim.ok).toBe(true);
    expect(sim.gasUsed).toBeGreaterThan(100_000n);
    // The simulation changed nothing on chain.
    expect(await adapter.readPosition(h.ref, safe)).toBeNull();
    expect(await execute(safe, built.calls)).toBe(true);
    const own = await h.own(safe);
    if (venue === "aave") near(sim.healthAfter, own.health, 1e-4); // Aave: the simulator reports the lender's health itself
    else expect(sim.healthAfter).toBeNull(); // other lenders: ok / failed step / gas only, health is the adapter's read
    expect(own.health).not.toBeNull();
  });

  it("2b. a batch that fails for real fails in the Test run too, at the step that reverts", async () => {
    const safe = await newSafe();
    const snap = await snapshot();
    await h.drainLiquidity();
    const built = open(safe, 1000);
    const sim = await simulateBatch({ client: fork.publicClient as never, chainId: 8453, safe, calls: built.calls, venue: id === "aave-v3" ? "aave" : "generic" });
    expect(sim.ok).toBe(false);
    expect(sim.failedStep).toBe(built.calls.length - 1); // the borrow
    expect(await execute(safe, built.calls)).toBe(false);
    await revert(snap);
  });

  it("3. buildProtect (add collateral, repay) reaches the predicted health", async () => {
    const safe = await newSafe();
    const { m, borrow } = await borrowFor(1.3);
    expect(await execute(safe, open(safe, borrow).calls)).toBe(true);
    const protect = adapter.buildProtect({ ref: h.ref, safe, addCollateral: { asset: "ETH", amount: 1 }, repay: 500 });
    expect(await execute(safe, protect.calls)).toBe(true);
    const own = await h.own(safe);
    near((((AMOUNT + 1) * m.collateralPriceUsd * m.liquidationThreshold) / (borrow - 500)), own.health);
    near((await adapter.readPosition(h.ref, safe))!.health, own.health, 0.001);
  });

  it("4. buildClose leaves zero debt and returns all collateral", async () => {
    const safe = await newSafe();
    const { borrow } = await borrowFor(1.6);
    expect(await execute(safe, open(safe, borrow).calls)).toBe(true);
    const wethBefore = await fork.publicClient.readContract({ address: WETH, abi: wethAbi, functionName: "balanceOf", args: [safe] });
    const close = await adapter.buildClose({ ref: h.ref, safe });
    expect(await execute(safe, close.calls)).toBe(true);
    expect(await adapter.readPosition(h.ref, safe)).toBeNull();
    const own = await h.own(safe);
    expect(own.health).toBeNull();
    const wethAfter = await fork.publicClient.readContract({ address: WETH, abi: wethAbi, functionName: "balanceOf", args: [safe] });
    // All collateral is back (within a wei of the lender's rounding).
    expect(wethAfter - wethBefore).toBeGreaterThanOrEqual(parseEther(String(AMOUNT)) - 2n);
  });

  it("5. a lower oracle price lowers health, and at health below 1 the lender's own liquidation succeeds", async () => {
    const safe = await newSafe();
    const { borrow } = await borrowFor(1.5);
    expect(await execute(safe, open(safe, borrow).calls)).toBe(true);
    const before = (await adapter.readPosition(h.ref, safe))!;
    expect(before.liquidatable).toBe(false);
    await expect(h.liquidate(safe)).rejects.toThrow();
    const snap = await snapshot();
    await h.setPrice(0.6);
    const after = (await adapter.readPosition(h.ref, safe))!;
    near(after.health, before.health! * 0.6, 0.01);
    expect(after.health!).toBeLessThan(1);
    expect(after.liquidatable).toBe(true);
    expect((await h.own(safe)).liquidatable).toBe(true);
    await h.liquidate(safe);
    await revert(snap);
  });

  it("6. a third party repays on behalf of the Safe with no approval from the Safe", async () => {
    const safe = await newSafe();
    const { borrow } = await borrowFor(1.6);
    expect(await execute(safe, open(safe, borrow).calls)).toBe(true);
    const before = (await adapter.readPosition(h.ref, safe))!.debt[0]!.amount;
    await setUsdc(fork, thirdParty.address, 1_000_000_000n);
    for (const c of adapter.buildRepay(h.ref, safe, 300).calls) await send(thirdParty, c.to, c.data, BigInt(c.value));
    const after = (await adapter.readPosition(h.ref, safe))!.debt[0]!.amount;
    expect(before - after).toBeGreaterThan(299);
    expect(before - after).toBeLessThan(301);
  });

  it("7. a market with too little liquidity makes the plan infeasible, and the batch would have failed", async () => {
    const safe = await newSafe();
    const snap = await snapshot();
    await h.drainLiquidity();
    const m = await adapter.readMarket(h.ref);
    expect(m.availableLiquidity).toBeLessThan(101);
    const verdict = canOpen(m, 1000);
    expect(verdict.ok).toBe(false);
    expect(await execute(safe, open(safe, 1000).calls)).toBe(false);
    await revert(snap);
  });

  it("8. a native ETH plan wraps ETH first", () => {
    const safe = "0x00000000000000000000000000000000000000a1" as Address;
    const built = open(safe, 1000);
    expect(built.steps[0]).toBe("Wrap ETH");
    expect(built.calls[0]).toMatchObject({ to: WETH, value: parseEther(String(AMOUNT)) });
    const noEth = adapter.buildOpen({ ref: h.ref, safe, collateral: { asset: "WETH", amount: AMOUNT }, borrow: 1000 });
    expect(noEth.steps).not.toContain("Wrap ETH");
  });

  it("9. an account that already holds another asset gets no plan on that lender", async () => {
    if (!h.addForeign) return; // Morpho: isolated market, nothing else can be held in it
    const safe = await newSafe();
    const { borrow } = await borrowFor(1.6);
    expect(await execute(safe, open(safe, borrow).calls)).toBe(true);
    expect(planAvailable(await adapter.readPosition(h.ref, safe))).toEqual({ ok: true });
    await h.addForeign(safe);
    const pos = (await adapter.readPosition(h.ref, safe))!;
    expect(pos.mixed).toBe(true);
    expect(planAvailable(pos)).toEqual({ ok: false, reason: "not available for this Safe yet" });
  });

  it("9b. close is refused for an account holding anything else, so no collateral is silently left behind", async () => {
    if (!h.addForeign) return;
    const safe = await newSafe();
    const { borrow } = await borrowFor(1.6);
    expect(await execute(safe, open(safe, borrow).calls)).toBe(true);
    await h.addForeign(safe);
    await expect(adapter.buildClose({ ref: h.ref, safe })).rejects.toThrow(/Closing is not available for this Safe yet/);
  });
});

describe("a position in a market that is not offered is still shown (Morpho wstETH/USDC)", () => {
  it("reads it, and builds no new borrowing", async () => {
    const wst = tokenBySymbol(8453, "wstETH")!.address!;
    const ref: MarketRef = { lender: "morpho-blue", chainId: 8453, marketId: "0x13c42741a359ac4a8aa8287d2be109dcf28344484f91185f9a79bd5a805a55ae", collateral: "wstETH" };
    const safe = await newSafe();
    // Give the Safe wstETH collateral and a loan there directly (not through the adapter).
    const slot = await findBalanceSlot(wst);
    await fork.testClient.setStorageAt({ address: wst, index: slot(safe), value: `0x${(10n ** 18n).toString(16).padStart(64, "0")}` });
    const [loanToken, collateralToken, oracle, irm, lltv] = await fork.publicClient.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "idToMarketParams", args: [ref.marketId as Hex] });
    const mp = { loanToken, collateralToken, oracle, irm, lltv };
    await asSafe(safe, [
      { to: wst, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO_BLUE, 10n ** 18n] }) },
      { to: MORPHO_BLUE, data: encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [mp, 10n ** 18n, safe, "0x"] }) },
      { to: MORPHO_BLUE, data: encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [mp, 500_000_000n, 0n, safe, safe] }) },
    ]);
    expect(offeredMarkets(8453).some((m) => m.marketId.toLowerCase() === ref.marketId.toLowerCase())).toBe(false);
    const pos = (await ADAPTERS["morpho-blue"].readPosition(ref, safe))!;
    expect(pos.collateral[0]!.amount).toBeCloseTo(1, 6);
    expect(pos.debt[0]!.amount).toBeCloseTo(500, 1);
    expect(pos.health!).toBeGreaterThan(1);
    expect(() => ADAPTERS["morpho-blue"].buildBorrow(ref, safe, 10)).toThrow(/not offered/);
  });
});

describe("positions in markets that are not offered are read with the tokens' own metadata (finding 10)", () => {
  it("Compound: a WETH-base Comet's 1e18 debt is read as WETH, not as 6-decimal USDC", async () => {
    const cWeth = "0x46e6b214b524310239732D51387075E0e70970bf" as Address;
    const wst = tokenBySymbol(8453, "wstETH")!.address!;
    const safe = await newSafe();
    const slot = await findBalanceSlot(wst);
    await fork.testClient.setStorageAt({ address: wst, index: slot(safe), value: `0x${(10n ** 19n).toString(16).padStart(64, "0")}` });
    await asSafe(safe, [
      { to: wst, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cWeth, 10n ** 19n] }) },
      { to: cWeth, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [wst, 10n ** 19n] }) },
      { to: cWeth, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [WETH, 10n ** 17n] }) },
    ]);
    const ref: MarketRef = { lender: "compound-v3", chainId: 8453, marketId: cWeth, collateral: "wstETH" };
    const pos = (await ADAPTERS["compound-v3"].readPosition(ref, safe))!;
    expect(pos.debt).toHaveLength(1);
    expect(pos.debt[0]!.asset).toBe("WETH");
    expect(pos.debt[0]!.amount).toBeCloseTo(0.1, 3);
    expect(pos.collateral[0]!.asset).toBe("wstETH");
    expect(pos.mixed).toBe(true); // not the plan's USDC pair: no close or plan is built on it
    await expect(ADAPTERS["compound-v3"].buildClose({ ref, safe })).rejects.toThrow(/not available/);
    const m = await ADAPTERS["compound-v3"].readMarket(ref);
    expect(m.availableLiquidity).toBeGreaterThanOrEqual(0);
    expect(m.availableLiquidity).toBeLessThan(1e7); // WETH units, not 1e12 times too small or large
  });

  it("Morpho: a market on a token outside WETH/wstETH/USDC is read", async () => {
    const cbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
    const p0 = await morphoHarness().params();
    const mp = { loanToken: p0.loanToken, collateralToken: cbBtc, oracle: p0.oracle, irm: p0.irm, lltv: p0.lltv };
    const { keccak256, encodeAbiParameters } = await import("viem");
    const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv])) as Hex;
    await send(liquidator, MORPHO_BLUE, encodeFunctionData({ abi: parseAbi(["function createMarket((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)"]), functionName: "createMarket", args: [mp] }));
    const safe = await newSafe();
    const slot = await findBalanceSlot(cbBtc);
    await fork.testClient.setStorageAt({ address: cbBtc, index: slot(safe), value: `0x${(10n ** 8n).toString(16).padStart(64, "0")}` }); // 1 cbBTC, 8 decimals
    await asSafe(safe, [
      { to: cbBtc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO_BLUE, 10n ** 8n] }) },
      { to: MORPHO_BLUE, data: encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [mp, 10n ** 8n, safe, "0x"] }) },
    ]);
    const ref = { lender: "morpho-blue", chainId: 8453, marketId: id, collateral: "WETH" } as MarketRef;
    const pos = (await ADAPTERS["morpho-blue"].readPosition(ref, safe))!;
    expect(pos.collateral[0]!.asset).toBe("cbBTC");
    expect(pos.collateral[0]!.amount).toBeCloseTo(1, 6); // 8 decimals read from the token
    expect(pos.debt).toEqual([]);
  });
});

describe("10. Morpho boundary: borrow capacity equal to debt is not liquidatable, one unit less price is", () => {
  it("matches the contract at the exact price boundary", async () => {
    const h = morphoHarness();
    const adapter = ADAPTERS["morpho-blue"];
    const safe = await newSafe();
    const m = await adapter.readMarket(h.ref);
    const borrow = Math.floor((2 * m.collateralPriceUsd * m.liquidationThreshold) / 1.5);
    // No interest while the boundary is probed: the IRM answers 0, so debt does not move between calls.
    const p = await h.params();
    expect(await execute(safe, adapter.buildOpen({ ref: h.ref, safe, collateral: { asset: "ETH", amount: 2 }, borrow }).calls)).toBe(true);
    await stubReturning(fork, p.irm, [0n]);
    await send(liquidator, MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "accrueInterest", args: [p] }));
    const [pos, mkt] = await Promise.all([
      fork.publicClient.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "position", args: [MORPHO_ID, safe] }),
      fork.publicClient.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [MORPHO_ID] }),
    ]);
    const borrowed = (pos[1] * (mkt[2] + 1n) + (mkt[3] + 1_000_000n) - 1n) / (mkt[3] + 1_000_000n);
    const healthyAt = (price: bigint) => (((pos[2] * price) / 10n ** 36n) * p.lltv) / WAD >= borrowed;
    let lo = 1n, hi = 10n ** 40n; // smallest price at which the position is healthy
    while (lo < hi) { const mid = (lo + hi) / 2n; if (healthyAt(mid)) hi = mid; else lo = mid + 1n; }
    const boundary = lo;
    const snap = await snapshot();

    await stubReturning(fork, p.oracle, [boundary]);
    const at = (await adapter.readPosition(h.ref, safe))!;
    expect(at.liquidatable).toBe(false);
    expect(at.health!).toBeGreaterThanOrEqual(1);
    expect(at.health!).toBeLessThan(1.0001);
    await expect(h.liquidate(safe)).rejects.toThrow();

    await stubReturning(fork, p.oracle, [boundary - 1n]);
    const below = (await adapter.readPosition(h.ref, safe))!;
    expect(below.liquidatable).toBe(true);
    expect(below.health!).toBeLessThan(1);
    await h.liquidate(safe);
    await revert(snap);
  });
});

/** Find how an ERC-20 stores `balances[address]` by probing slot indexes 0..20 (test token setup only). */
async function findBalanceSlot(token: Address): Promise<(who: Address) => Hex> {
  const { keccak256, encodeAbiParameters } = await import("viem");
  const who = "0x00000000000000000000000000000000000000b1" as Address;
  for (let i = 0n; i < 20n; i++) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, i]));
    const prev = await fork.publicClient.getStorageAt({ address: token, slot });
    await fork.testClient.setStorageAt({ address: token, index: slot, value: `0x${(123456789n).toString(16).padStart(64, "0")}` });
    const bal = await fork.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
    await fork.testClient.setStorageAt({ address: token, index: slot, value: (prev ?? "0x00") as Hex });
    if (bal === 123456789n) return (a) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, i]));
  }
  throw new Error("balance slot not found");
}
