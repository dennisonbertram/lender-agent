// Chain reads on a Base fork (block 57,172,000): build a real Aave position, then read it back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther, parseUnits, type PublicClient } from "viem";
import { dataProviderAbi, erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, ALLOWLIST, MULTISEND_CALL_ONLY, tokenBySymbol } from "@/server/chain/config";
import { readAaveMarket, readAavePosition, readBalances, readPrices } from "@/server/chain/reads";
import { isDeployed, readSafeOwners } from "@/server/chain/safe";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";

const aave = AAVE[8453]!;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;
const account = privateKeyToAccount(ANVIL_KEYS[3]);
const me = account.address as Address;

let fork: Fork;

/** The public RPC can rate-limit the fork's lazy state fetches: retry with backoff. */
async function retry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(req: any) {
  const hash = await retry(() => fork.walletClient.writeContract({ account, chain: fork.chain, ...req }));
  const receipt = await fork.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${req.functionName}`);
}

beforeAll(async () => {
  fork = await startBaseFork();
  setPublicClientForTests(8453, fork.publicClient as PublicClient);
  await fork.testClient.setBalance({ address: me, value: parseEther("100") });
  await send({ address: WETH, abi: wethAbi, functionName: "deposit", value: parseEther("10") });
  await send({ address: WETH, abi: erc20Abi, functionName: "approve", args: [aave.pool, parseEther("10")] });
  await send({ address: aave.pool, abi: poolAbi, functionName: "supply", args: [WETH, parseEther("10"), me, 0] });
  await send({ address: aave.pool, abi: poolAbi, functionName: "borrow", args: [USDC, parseUnits("5000", 6), 2n, 0, me] });
}, 240_000);

afterAll(async () => {
  setPublicClientForTests(8453, undefined);
  await fork?.stop();
});

describe("chain reads on a Base fork", () => {
  it("readAavePosition matches getUserAccountData at the same block and names the block", async () => {
    const { position, blockNumber, chainId } = await readAavePosition(8453, me);
    expect(chainId).toBe(8453);
    expect(position).not.toBeNull();
    expect(position!.blockNumber).toBe(blockNumber);
    const data = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [me], blockNumber });
    expect(position!.healthFactor).toBeCloseTo(Number(data[5]) / 1e18, 12);
    expect(position!.ltv).toBeCloseTo(Number(data[4]) / 1e4, 6);
    expect(position!.liquidationThreshold).toBeCloseTo(Number(data[3]) / 1e4, 6);
    expect(position!.collateral).toHaveLength(1);
    expect(position!.collateral[0]).toMatchObject({ asset: "WETH" });
    expect(position!.collateral[0]!.amount).toBeCloseTo(10, 6);
    expect(position!.debt).toHaveLength(1);
    expect(position!.debt[0]!.asset).toBe("USDC");
    expect(position!.debt[0]!.amount).toBeCloseTo(5000, 2);
    expect(position!.mixed).toBe(false);
    expect(position!.id).toBe(`8453:${me.toLowerCase()}:aave-v3`);
    // USD values agree with the lender's base-currency totals (8 decimals).
    expect(position!.debt[0]!.usd).toBeCloseTo(Number(data[1]) / 1e8, 1);
    expect(position!.collateral[0]!.usd).toBeCloseTo(Number(data[0]) / 1e8, 0);
  });

  it("returns null position for an account with no Aave activity", async () => {
    const empty = "0x1234567890123456789012345678901234567890" as Address;
    expect((await readAavePosition(8453, empty)).position).toBeNull();
  });

  it("readBalances: ETH and USDC", async () => {
    const r = await readBalances(8453, me);
    const eth = r.balances.find((b) => b.symbol === "ETH")!;
    const usdc = r.balances.find((b) => b.symbol === "USDC")!;
    expect(eth.amount).toBeGreaterThan(80);
    expect(eth.amount).toBeLessThan(100);
    expect(usdc.raw).toBe(parseUnits("5000", 6));
    expect(usdc.amount).toBe(5000);
    expect(r.balances.map((b) => b.symbol)).toEqual(["ETH", "WETH", "wstETH", "USDC"]);
    expect(r.blockNumber).toBeGreaterThan(57_172_000n);
  });

  it("readAaveMarket for WETH and USDC", async () => {
    const { market, blockNumber } = await readAaveMarket(8453, WETH);
    expect(blockNumber).toBeGreaterThan(0n);
    expect(market.symbol).toBe("WETH");
    expect(market.ltv).toBeGreaterThan(0);
    expect(market.liquidationThreshold).toBeGreaterThan(market.ltv);
    expect(market.availableLiquidity).toBeGreaterThan(0);
    expect(market.decimals).toBe(18);
    expect(market.isActive).toBe(true);
    expect(market.isPaused).toBe(false);
    const usdc = (await readAaveMarket(8453, USDC)).market;
    expect(usdc.decimals).toBe(6);
    expect(usdc.variableBorrowApr).toBeGreaterThan(0);
    expect(usdc.variableBorrowApr).toBeLessThan(1);
    expect(usdc.borrowingEnabled).toBe(true);
  });

  it("readPrices from the Aave oracle", async () => {
    const { prices } = await readPrices(8453);
    expect(prices.WETH).toBeGreaterThan(500);
    expect(prices.ETH).toBe(prices.WETH);
    expect(prices.wstETH).toBeGreaterThan(prices.WETH!);
    expect(prices.USDC).toBeGreaterThan(0.9);
    expect(prices.USDC).toBeLessThan(1.1);
  });

  it("Safe reads: null owners for an EOA, not deployed", async () => {
    const eoa = "0x1234567890123456789012345678901234567890" as Address;
    expect(await readSafeOwners(8453, eoa)).toBeNull();
    expect(await isDeployed(8453, eoa)).toBe(false);
    // The anvil key may carry EIP-7702 delegation code on Base mainnet: still not a Safe.
    expect(await readSafeOwners(8453, me)).toBeNull();
    expect(await isDeployed(8453, MULTISEND_CALL_ONLY)).toBe(true);
  });

  it("configured Aave addresses are the live ones and the allowlist covers them", async () => {
    const provider = await fork.publicClient.readContract({ address: aave.pool, abi: [{ type: "function", name: "ADDRESSES_PROVIDER", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }], functionName: "ADDRESSES_PROVIDER" });
    expect(provider.toLowerCase()).toBe(aave.addressesProvider.toLowerCase());
    const reserves = await fork.publicClient.readContract({ address: aave.dataProvider, abi: dataProviderAbi, functionName: "getAllReservesTokens" });
    const symbols = reserves.map((r) => r.symbol);
    expect(symbols).toEqual(expect.arrayContaining(["WETH", "wstETH", "USDC"]));
    expect(symbols).not.toContain("WBTC"); // not listed on Aave v3 Base
    for (const a of [aave.pool, WETH, USDC, MULTISEND_CALL_ONLY]) expect(ALLOWLIST[8453]).toContain(a.toLowerCase());
  });
});
