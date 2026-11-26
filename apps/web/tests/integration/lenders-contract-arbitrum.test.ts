// BP-35: the BP-32 adapter contract suite (test-plan layer 2, "per lender adapter") on an Arbitrum fork, run for
// every adapter the allowlist offers there (Aave v3). A network is added by configuration once this passes.
// Same numbering as lenders-contract.test.ts (items 1-9; item 10 is the Morpho boundary).
// Item 2 ("simulation equals execution") is a dry run: execute on a snapshot, revert, execute again,
// and compare the two results.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { setPublicClientForTests } from "@/server/chain/client";
import { erc20Abi, poolAbi, oracleAbi, wethAbi } from "@/server/chain/abis";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { buildOuterTx } from "@/server/aave/build";
import type { Call } from "@/server/safe/multisend";
import { ADAPTERS, canOpen, offeredMarkets, planAvailable, type LenderAdapter, type MarketRef } from "@/server/lenders";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, type Fork } from "../helpers/anvil";
import { startFork } from "../helpers/multi-fork";
import { stubReturning, setUsdc } from "../helpers/oracle";
import { deployTestSafe, execSafeTx, safeAbi } from "../helpers/safe";

const CHAIN = 42161 as const;
const WETH = tokenBySymbol(CHAIN, "WETH")!.address!;
const USDC = tokenBySymbol(CHAIN, "USDC")!.address!;
const aave = AAVE[CHAIN]!;
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
    ref: { lender: "aave-v3", chainId: CHAIN, marketId: aave.pool, collateral: "WETH" },
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
      await setUsdc(fork, liquidator.address, 1_000_000_000n, USDC);
      await send(liquidator, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [aave.pool, 2n ** 255n] }));
      await send(liquidator, aave.pool, encodeFunctionData({ abi: aaveExtra, functionName: "liquidationCall", args: [WETH, USDC, safe, 100_000_000n, false] }));
    },
    async addForeign(safe) {
      // USDC supplied as collateral next to WETH: the account is no longer the plan's own pair.
      await setUsdc(fork, safe, 1_000_000_000n, USDC);
      await asSafe(safe, [
        { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [aave.pool, 100_000_000n] }) },
        { to: aave.pool, data: encodeFunctionData({ abi: poolAbi, functionName: "supply", args: [USDC, 100_000_000n, safe, 0] }) },
      ]);
    },
    async drainLiquidity() {
      const dp = parseAbi(["function getReserveTokensAddresses(address) view returns (address,address,address)"]);
      const [aUsdc] = await fork.publicClient.readContract({ address: aave.dataProvider, abi: dp, functionName: "getReserveTokensAddresses", args: [USDC] });
      await setUsdc(fork, aUsdc, 100_000_000n, USDC);
    },
  };
}


async function newSafe(): Promise<Address> {
  const { address } = await deployTestSafe({ fork, owners: [owner], threshold: 1, saltNonce: String(saltCounter++) });
  await fork.testClient.setBalance({ address, value: parseEther("20") });
  await setUsdc(fork, address, 50_000_000n, USDC); // a little USDC for interest at close
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
  fork = await startFork(CHAIN) as unknown as Fork;
  setPublicClientForTests(CHAIN, fork.publicClient as never);
}, 240_000);
afterAll(async () => {
  setPublicClientForTests(CHAIN, undefined);
  await fork?.stop();
});

const harnesses: [string, () => Harness][] = [
  ["aave-v3", aaveHarness],
];

describe("allowlist rows are the ones the suite covers", () => {
  it("every offered Arbitrum market has a harness below", () => {
    expect(offeredMarkets(CHAIN).map((m) => m.lender).sort()).toEqual(harnesses.map(([id]) => id).sort());
  });
});

describe.each(harnesses)("adapter contract: %s on the Arbitrum fork", (id, make) => {
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

  it("2. a dry run of the batch gives the same result as the real run", async () => {
    const safe = await newSafe();
    const { borrow } = await borrowFor(1.6);
    const built = open(safe, borrow);
    const snap = await snapshot();
    expect(await execute(safe, built.calls)).toBe(true);
    const dry = (await adapter.readPosition(h.ref, safe))!;
    await revert(snap);
    expect(await adapter.readPosition(h.ref, safe)).toBeNull();
    expect(await execute(safe, built.calls)).toBe(true);
    const real = (await adapter.readPosition(h.ref, safe))!;
    near(real.health, dry.health, 1e-5);
    expect(real.collateral[0]!.amount).toBe(dry.collateral[0]!.amount);
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
    await setUsdc(fork, thirdParty.address, 1_000_000_000n, USDC);
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
});

