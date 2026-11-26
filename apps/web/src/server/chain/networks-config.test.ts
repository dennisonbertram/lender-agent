// BP-35: a network is added by configuration. Every table keyed by ChainId carries the new network, and a
// lender is only offered on the network it is deployed on.
import { describe, expect, it } from "vitest";
import { ALLOWLIST, AAVE, TOKENS, VIEM_CHAINS, erc20Tokens, tokenBySymbol } from "./config";
import { createFixtureReader } from "./fixture";
import { CHAIN_IDS, CHAIN_NAME, NETWORK_OF, SAFE_PREFIX, isChainId, type ChainId } from "@/shared/types";
import { MARKET_ALLOWLIST, isOffered, offeredMarkets } from "@/server/lenders/allowlist";
import { serviceUrlFor } from "@/server/safe/service-client";
import { SAFE_NETWORKS, SERVED_CHAIN_IDS } from "@/lib/safe-create";

const ids = Object.values(CHAIN_IDS) as ChainId[];

describe("ChainId covers Arbitrum through the same types", () => {
  it("has one entry per chain in every table", () => {
    expect(CHAIN_IDS.arbitrum).toBe(42161);
    expect(isChainId(42161)).toBe(true);
    expect(isChainId(10)).toBe(false);
    for (const id of ids) {
      expect(VIEM_CHAINS[id].id).toBe(id);
      expect(NETWORK_OF[id]).toBeTruthy();
      expect(SAFE_PREFIX[id]).toBeTruthy();
      expect(CHAIN_NAME[id]).toBeTruthy();
      expect(ALLOWLIST[id]).toBeTruthy();
      expect(serviceUrlFor(id, {})).toMatch(/^https:\/\//);
    }
    expect(NETWORK_OF[42161]).toBe("arbitrum");
    expect(CHAIN_NAME[42161]).toBe("Arbitrum");
  });
  it("Arbitrum has Aave v3, WETH, wstETH and native USDC, and its names match the Safe network list", () => {
    expect(AAVE[42161]!.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    for (const s of ["WETH", "wstETH", "USDC"]) expect(tokenBySymbol(42161, s)!.available).toBe(true);
    expect(tokenBySymbol(42161, "USDC")!.address).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(TOKENS[42161]!.every((t) => t.address === null || erc20Tokens(42161).some((e) => e.address === t.address))).toBe(true);
    expect(SAFE_NETWORKS.find((n) => n.chainId === 42161)!.name).toBe(CHAIN_NAME[42161]);
    expect(SERVED_CHAIN_IDS).toContain(42161);
  });
  it("the batch allowlist for Arbitrum holds the Aave pool and its tokens and nothing from Base", () => {
    expect(ALLOWLIST[42161]).toContain(AAVE[42161]!.pool.toLowerCase());
    expect(ALLOWLIST[42161]).not.toContain(AAVE[8453]!.pool.toLowerCase());
  });
});

describe("lender allowlist by network", () => {
  it("offers Aave on Arbitrum and no lender that is not deployed there", () => {
    expect(offeredMarkets(42161).map((m) => m.lender)).toEqual(["aave-v3"]);
    expect(offeredMarkets(8453).map((m) => m.lender).sort()).toEqual(["aave-v3", "compound-v3", "morpho-blue"]);
    expect(MARKET_ALLOWLIST.filter((m) => m.chainId === 42161).every((m) => m.marketId === AAVE[42161]!.pool)).toBe(true);
  });
  it("a market is only valid on its own network", () => {
    const pool = AAVE[42161]!.pool;
    expect(isOffered({ lender: "aave-v3", chainId: 42161, marketId: pool, collateral: "WETH" })).toBe(true);
    expect(isOffered({ lender: "aave-v3", chainId: 8453, marketId: pool, collateral: "WETH" })).toBe(false);
    expect(isOffered({ lender: "compound-v3", chainId: 42161, marketId: pool, collateral: "WETH" })).toBe(false);
  });
});

describe("the chain reader handles Arbitrum", () => {
  it("reads balances of the Arbitrum tokens and keeps them apart from Base", async () => {
    const reader = createFixtureReader();
    const safe = "0x00000000000000000000000000000000000000a1" as const;
    reader.setBalances(42161, safe, { USDC: 250 });
    const arb = await reader.readBalances(42161, safe);
    expect(arb.chainId).toBe(42161);
    expect(arb.balances.find((b) => b.symbol === "USDC")).toMatchObject({ amount: 250, token: tokenBySymbol(42161, "USDC")!.address });
    expect((await reader.readBalances(8453, safe)).balances.find((b) => b.symbol === "USDC")?.amount ?? 0).toBe(0);
    expect((await reader.readAaveMarket(42161, tokenBySymbol(42161, "WETH")!.address!)).market.symbol).toBe("WETH");
  });
});
