// BP-32 unit tests (no network): the market allowlist, the plan-feasibility rule, the
// per-lender liquidation sentence and the adapter shape. The chain side is in
// tests/integration/lenders-contract.test.ts.
import { describe, expect, it } from "vitest";
import { liquidationSentence } from "@/server/blocks/explain";
import { ADAPTERS, adapterFor, canOpen, isOffered, MARKET_ALLOWLIST, offeredMarkets, planAvailable, type AdapterMarket, type AdapterPosition } from "./index";

const ids = ["aave-v3", "compound-v3", "morpho-blue"] as const;
const MORPHO_WETH_USDC = "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda";
const MORPHO_WSTETH_USDC = "0x13c42741a359ac4a8aa8287d2be109dcf28344484f91185f9a79bd5a805a55ae";

const market = (over: Partial<AdapterMarket> = {}): AdapterMarket => ({
  ref: { lender: "aave-v3", chainId: 8453, marketId: "m", collateral: "WETH" }, name: "x", collateralPriceUsd: 3000, ltv: 0.8, liquidationThreshold: 0.83,
  borrowApr: 0.05, availableLiquidity: 1_000_000, borrowCapLeft: null, minBorrow: 0, collateralSupplyCapLeft: null, borrowable: true, blockNumber: 1n, ...over,
});

describe("market allowlist (D-04)", () => {
  it("lists Base and Arbitrum only, one typed row per (lender, network, market), and no Spark", () => {
    expect(new Set(MARKET_ALLOWLIST.map((m) => m.chainId))).toEqual(new Set([8453, 42161]));
    expect(new Set(MARKET_ALLOWLIST.map((m) => m.lender))).toEqual(new Set(ids));
    const keys = MARKET_ALLOWLIST.map((m) => `${m.lender}:${m.chainId}:${m.marketId.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("offers the Morpho WETH/USDC market by id and not the thinner wstETH/USDC one", () => {
    const morpho = offeredMarkets(8453).filter((m) => m.lender === "morpho-blue");
    expect(morpho.map((m) => m.marketId)).toEqual([MORPHO_WETH_USDC]);
    expect(isOffered({ lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC, collateral: "WETH" })).toBe(true);
    expect(isOffered({ lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WSTETH_USDC, collateral: "wstETH" })).toBe(false);
  });
  it("offers nothing on a network that is not listed", () => {
    expect(offeredMarkets(1 as never)).toEqual([]);
    expect(offeredMarkets(84532)).toEqual([]);
  });
  it("never builds new borrowing in a market that is not offered", () => {
    const ref = { lender: "morpho-blue" as const, chainId: 8453 as const, marketId: MORPHO_WSTETH_USDC, collateral: "wstETH" as const };
    const safe = "0x00000000000000000000000000000000000000a1" as const;
    expect(() => adapterFor("morpho-blue").buildOpen({ ref, safe, collateral: { asset: "wstETH", amount: 1 }, borrow: 100 })).toThrow(/not offered/);
    expect(() => adapterFor("morpho-blue").buildBorrow(ref, safe, 100)).toThrow(/not offered/);
    // Repaying it is still allowed: people must be able to exit.
    expect(adapterFor("morpho-blue").buildRepay(ref, safe, 10).calls.length).toBeGreaterThan(0);
  });
});

describe("native ETH is only an input for a WETH market (finding 8)", () => {
  const safe = "0x00000000000000000000000000000000000000a1" as const;
  const wst = (lender: "aave-v3" | "compound-v3") => ({ lender, chainId: 8453 as const, marketId: MARKETS[lender], collateral: "wstETH" as const });
  const MARKETS = { "aave-v3": MARKET_ALLOWLIST.find((m) => m.lender === "aave-v3")!.marketId, "compound-v3": MARKET_ALLOWLIST.find((m) => m.lender === "compound-v3")!.marketId };
  it.each(["aave-v3", "compound-v3"] as const)("%s refuses ETH for a wstETH market in open, supply and protect", (id) => {
    const a = adapterFor(id), ref = wst(id);
    expect(() => a.buildOpen({ ref, safe, collateral: { asset: "ETH", amount: 1 }, borrow: 100 })).toThrow(/not this market's collateral/);
    expect(() => a.buildSupply(ref, safe, "ETH", 1)).toThrow(/not this market's collateral/);
    expect(() => a.buildProtect({ ref, safe, addCollateral: { asset: "ETH", amount: 1 } })).toThrow(/not this market's collateral/);
    expect(a.buildOpen({ ref, safe, collateral: { asset: "wstETH", amount: 1 }, borrow: 100 }).steps).not.toContain("Wrap ETH");
  });
  it.each(["aave-v3", "compound-v3"] as const)("%s still wraps ETH for a WETH market", (id) => {
    const ref = { ...wst(id), collateral: "WETH" as const };
    expect(adapterFor(id).buildOpen({ ref, safe, collateral: { asset: "ETH", amount: 1 }, borrow: 100 }).steps[0]).toBe("Wrap ETH");
  });
});

describe("adapter shape", () => {
  it.each(ids)("%s has the same functions", (id) => {
    const a = ADAPTERS[id];
    expect(a.id).toBe(id);
    for (const f of ["readPosition", "readMarket", "buildSupply", "buildBorrow", "buildRepay", "buildWithdraw", "buildOpen", "buildProtect", "buildClose", "liquidationSentence"] as const) {
      expect(typeof a[f]).toBe("function");
    }
  });
});

describe("liquidation sentence", () => {
  it("Compound v3 says the whole account is taken (M4 exit 3)", () => {
    const s = adapterFor("compound-v3").liquidationSentence();
    expect(s).toMatch(/whole account/i);
    expect(s).toMatch(/all of your collateral/i);
    expect(s).not.toMatch(/only part of your collateral/i);
  });
  it("Aave v3 and Morpho say part, and Aave matches the explain copy", () => {
    expect(adapterFor("aave-v3").liquidationSentence()).toBe(liquidationSentence("Aave v3"));
    expect(adapterFor("morpho-blue").liquidationSentence()).toMatch(/only part/i);
  });
});

describe("canOpen: an infeasible plan is refused, not sent", () => {
  it("accepts a borrow the market can serve", () => expect(canOpen(market(), 1000)).toEqual({ ok: true }));
  it("refuses when liquidity is too low", () => expect(canOpen(market({ availableLiquidity: 500 }), 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/liquidity/i) }));
  it("refuses when the borrow cap is reached", () => expect(canOpen(market({ borrowCapLeft: 10 }), 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/cap/i) }));
  it("refuses when the collateral supply cap is reached", () => expect(canOpen(market({ collateralSupplyCapLeft: 0 }), 1000, 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/cap/i) }));
  it("refuses a paused or frozen market", () => expect(canOpen(market({ borrowable: false, notBorrowableReason: "frozen" }), 1000)).toMatchObject({ ok: false, reason: "frozen" }));
  it("refuses below the minimum borrow", () => expect(canOpen(market({ minBorrow: 100 }), 50)).toMatchObject({ ok: false, reason: expect.stringMatching(/minimum/i) }));
});

describe("planAvailable: one position unit (architecture 7, D-05)", () => {
  const pos = (mixed: boolean): AdapterPosition => ({
    lender: "aave-v3", chainId: 8453, safe: "0x00000000000000000000000000000000000000a1", marketId: "m", collateral: [], debt: [], health: 2, liquidatable: false, liquidationThreshold: 0.8, mixed, blockNumber: 1n,
  });
  it("offers a plan with no position or a position of the plan's own pair", () => {
    expect(planAvailable(null)).toEqual({ ok: true });
    expect(planAvailable(pos(false))).toEqual({ ok: true });
  });
  it("says not available for this Safe yet when the account holds anything else", () => {
    expect(planAvailable(pos(true))).toEqual({ ok: false, reason: "not available for this Safe yet" });
  });
});
