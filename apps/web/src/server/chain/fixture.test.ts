import { describe, expect, it } from "vitest";
import { createFixtureReader } from "./fixture";

const safe = "0x00000000000000000000000000000000000000Aa" as const;
const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;

describe("fixture reader", () => {
  it("reads null for unknown Safes, then the owners set by setOwners", async () => {
    const r = createFixtureReader();
    expect(await r.readSafeOwners(8453, safe)).toBeNull();
    expect(await r.isDeployed(8453, safe)).toBe(false);
    r.setOwners(8453, safe, [owner], 1);
    expect(await r.readSafeOwners(8453, safe)).toEqual([owner]);
    expect(await r.readSafeThreshold(8453, safe)).toBe(1);
    expect(await r.readSafeNonce(8453, safe)).toBe(0n);
    r.removeSafe(8453, safe);
    expect(await r.readSafeOwners(8453, safe)).toBeNull();
  });

  it("balances: unset tokens are zero, set ones carry raw units; block counter advances", async () => {
    const r = createFixtureReader();
    r.setBalances(8453, safe, { ETH: 1.5, USDC: 200 });
    const b = await r.readBalances(8453, safe);
    expect(b.balances.find((x) => x.symbol === "USDC")).toMatchObject({ amount: 200, raw: 200_000_000n });
    expect(b.balances.find((x) => x.symbol === "ETH")!.raw).toBe(1_500_000_000_000_000_000n);
    expect(b.balances.find((x) => x.symbol === "WETH")!.amount).toBe(0);
    expect(b.balances.some((x) => x.symbol === "WBTC")).toBe(false);
    const before = b.blockNumber;
    r.mine(3);
    expect((await r.readBalances(8453, safe)).blockNumber).toBe(before + 3n);
  });

  it("positions, markets and prices", async () => {
    const r = createFixtureReader();
    expect((await r.readAavePosition(8453, safe)).position).toBeNull();
    const position = {
      chainId: 8453 as const, safe, lender: "aave-v3" as const, id: "x", collateral: [], debt: [],
      healthFactor: 2, liquidationThreshold: 0.8, ltv: 0.7, mixed: false, blockNumber: 0n,
    };
    r.setPosition(8453, safe, position);
    const read = await r.readAavePosition(8453, safe);
    expect(read.position!.healthFactor).toBe(2);
    expect(read.position!.blockNumber).toBe(read.blockNumber);
    expect((await r.readAaveMarket(8453, WETH)).market.ltv).toBeGreaterThan(0);
    r.setPrices({ WETH: 2500 });
    expect((await r.readPrices(8453)).prices).toMatchObject({ WETH: 2500, ETH: 2500 });
  });
});
