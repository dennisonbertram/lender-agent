// Morpho readPosition on a non-USDC loan market, against a scripted chain client: dollar figures are dollars, never raw loan-token amounts.
import { afterEach, describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { erc20Tokens, tokenBySymbol } from "@/server/chain/config";
import { setPublicClientForTests } from "@/server/chain/client";
import type { Address } from "@/shared/types";
import { morphoAdapter } from "./morpho";
import type { MarketRef } from "./types";

const WETH = tokenBySymbol(8453, "WETH")!.address!;
const WSTETH = tokenBySymbol(8453, "wstETH")!.address!;
const UNKNOWN = "0x00000000000000000000000000000000000000aa" as Address;
const ORACLE = "0x00000000000000000000000000000000000000bb" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const PRICES: Record<string, number> = { WETH: 3000, wstETH: 3600, USDC: 1 };

function fakeClient(o: { id: string; loan: Address; coll: Address; symbols?: Record<string, string>; pricesFail?: boolean; priceBlocks?: (bigint | undefined)[]; pricesByBlock?: Record<string, Record<string, number>> }) {
  const sym = (a: string) => o.symbols?.[a.toLowerCase()] ?? erc20Tokens(8453).find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol ?? "XYZ";
  return {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ timestamp: 1_000n }),
    readContract: async ({ functionName, address }: { functionName: string; address: Address }) => {
      switch (functionName) {
        case "idToMarketParams": return [o.loan, o.coll, ORACLE, ZERO, 860000000000000000n];
        case "market": return [10n ** 24n, 10n ** 30n, 10n ** 18n, 10n ** 24n, 1_000n, 0n]; // 1e18 borrowed, no accrual
        case "price": return 12n * 10n ** 35n; // 1.2 loan tokens per collateral token (both 18 decimals)
        case "position": return [0n, 10n ** 24n, 10n * 10n ** 18n]; // 1 loan token of debt, 10 collateral
        case "decimals": return 18;
        case "symbol": return sym(address);
        default: throw new Error(`unexpected ${functionName}`);
      }
    },
    multicall: async ({ blockNumber }: { blockNumber?: bigint }) => {
      o.priceBlocks?.push(blockNumber);
      if (o.pricesFail) throw new Error("oracle down");
      const prices = o.pricesByBlock?.[String(blockNumber)] ?? PRICES;
      return [erc20Tokens(8453).map((t) => BigInt(Math.round((prices[t.symbol] ?? 1) * 1e8))), 10n ** 8n];
    },
  } as unknown as PublicClient;
}

const ref = (id: string): MarketRef => ({ lender: "morpho-blue", chainId: 8453, marketId: id, collateral: "wstETH" });
afterEach(() => setPublicClientForTests(8453, undefined));

describe("Morpho readPosition with a WETH loan", () => {
  it("1 WETH of debt is $3,000, and the collateral is priced in dollars too", async () => {
    setPublicClientForTests(8453, fakeClient({ id: "0x01", loan: WETH, coll: WSTETH }));
    const p = (await morphoAdapter.readPosition(ref("0x01"), SAFE))!;
    expect(p.debt[0]).toMatchObject({ asset: "WETH" });
    expect(p.debt[0]!.amount).toBeCloseTo(1, 6);
    expect(p.debt[0]!.usd).toBeCloseTo(3000, 2);
    expect(p.collateral[0]!.usd).toBeCloseTo(10 * 1.2 * 3000, 2); // 10 wstETH worth 12 WETH
    expect(p.mixed).toBe(true);
  });

  it("a pinned position values debt and collateral with that block's prices, not latest", async () => {
    const priceBlocks: (bigint | undefined)[] = [];
    setPublicClientForTests(8453, fakeClient({
      id: "0x04", loan: WETH, coll: WSTETH, priceBlocks,
      pricesByBlock: { "42": { WETH: 2_000, wstETH: 2_400, USDC: 1 }, "100": PRICES },
    }));
    const p = (await morphoAdapter.readPosition(ref("0x04"), SAFE, 42n))!;
    expect(p.blockNumber).toBe(42n);
    expect(priceBlocks).toEqual([42n]);
    expect(p.debt[0]!.usd).toBeCloseTo(2_000, 2);
    expect(p.collateral[0]!.usd).toBeCloseTo(10 * 1.2 * 2_000, 2);
  });

  it("an unpinned position reads prices at the resolved latest block", async () => {
    const priceBlocks: (bigint | undefined)[] = [];
    setPublicClientForTests(8453, fakeClient({ id: "0x05", loan: WETH, coll: WSTETH, priceBlocks }));
    const p = (await morphoAdapter.readPosition(ref("0x05"), SAFE))!;
    expect(p.blockNumber).toBe(100n);
    expect(priceBlocks).toEqual([100n]);
  });

  it("a pinned position reads the collateral's own fallback price at that block", async () => {
    const priceBlocks: (bigint | undefined)[] = [];
    // An unknown loan token has no price, so the collateral falls back to its own oracle price.
    setPublicClientForTests(8453, fakeClient({ id: "0x06", loan: UNKNOWN, coll: WSTETH, symbols: { [UNKNOWN]: "XYZ" }, priceBlocks }));
    const p = (await morphoAdapter.readPosition(ref("0x06"), SAFE, 42n))!;
    expect(p.blockNumber).toBe(42n);
    expect(p.debt[0]!.usd).toBeNull();
    expect(priceBlocks).toEqual([42n]); // one fallback read, at the pinned block
    expect(p.collateral[0]!.usd).toBeCloseTo(10 * 3600, 2);
  });

  it("when no price can be read, usd is unknown (null), not the token amount", async () => {
    setPublicClientForTests(8453, fakeClient({ id: "0x02", loan: UNKNOWN, coll: WSTETH, symbols: { [UNKNOWN]: "XYZ" } }));
    const p = (await morphoAdapter.readPosition(ref("0x02"), SAFE))!;
    expect(p.debt[0]!.usd).toBeNull();
    expect(p.debt[0]!.amount).toBeCloseTo(1, 6);
    expect(p.collateral[0]!.usd).toBeCloseTo(10 * 3600, 2); // the collateral has a known price of its own
    setPublicClientForTests(8453, fakeClient({ id: "0x03", loan: WETH, coll: WSTETH, pricesFail: true }));
    const q = (await morphoAdapter.readPosition(ref("0x03"), SAFE))!;
    expect(q.debt[0]!.usd).toBeNull();
    expect(q.collateral[0]!.usd).toBeNull();
  });
});
