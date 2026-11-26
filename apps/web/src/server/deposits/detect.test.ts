import { describe, expect, it } from "vitest";
import { detectRises, WATCHED_ASSETS } from "./detect";

const bal = (symbol: string, raw: bigint, decimals = 18) => ({ symbol, token: null, decimals, amount: Number(raw) / 10 ** decimals, raw });

describe("detectRises", () => {
  it("watches ETH, wstETH and WBTC only", () => {
    expect(WATCHED_ASSETS).toEqual(["ETH", "wstETH", "WBTC"]);
  });

  it("a rise over the stored balance is a deposit of the difference", () => {
    const r = detectRises(new Map([["ETH", 1_000n]]), [bal("ETH", 5_000n)]);
    expect(r.rises).toEqual([{ asset: "ETH", raw: 4_000n, decimals: 18 }]);
    expect(r.next.get("ETH")).toBe(5_000n);
  });

  it("no change and a fall are not deposits, and a fall lowers the baseline", () => {
    const r = detectRises(new Map([["ETH", 5_000n], ["wstETH", 9n]]), [bal("ETH", 5_000n), bal("wstETH", 4n)]);
    expect(r.rises).toEqual([]);
    expect(r.next.get("wstETH")).toBe(4n);
  });

  it("the first observation of an asset is a baseline, not a deposit", () => {
    const r = detectRises(new Map(), [bal("ETH", 7n)]);
    expect(r.rises).toEqual([]);
    expect(r.next.get("ETH")).toBe(7n);
  });

  it("an asset first seen after a baseline exists counts from zero", () => {
    const r = detectRises(new Map([["ETH", 1n]]), [bal("ETH", 1n), bal("wstETH", 3n)]);
    expect(r.rises).toEqual([{ asset: "wstETH", raw: 3n, decimals: 18 }]);
  });

  it("ignores assets that are not collateral (USDC, WETH)", () => {
    const r = detectRises(new Map([["ETH", 0n]]), [bal("ETH", 0n), bal("USDC", 9_000_000n, 6), bal("WETH", 5n)]);
    expect(r.rises).toEqual([]);
    expect(r.next.has("USDC")).toBe(false);
  });

  it("several assets rising at once give one deposit each", () => {
    const r = detectRises(new Map([["ETH", 0n], ["wstETH", 0n]]), [bal("ETH", 1n), bal("wstETH", 2n)]);
    expect(r.rises.map((x) => x.asset)).toEqual(["ETH", "wstETH"]);
  });
});
