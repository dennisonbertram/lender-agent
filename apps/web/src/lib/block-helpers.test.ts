import { describe, expect, it } from "vitest";
import { NETWORKS, SAMPLE_LOANS, BASE_PRICES, VENUES } from "../../tests/fixtures/legacy-data";
import { hypotheticalLoan, holdingRows, whatIfRows } from "@/lib/block-helpers";

const T = { aave: { warn: 1.6, act: 1.35 }, spark: { warn: 1.6, act: 1.35 } };

describe("block helpers", () => {
  it("whatIfRows lowers health only for loans on the falling asset", () => {
    const eth = SAMPLE_LOANS.filter((l) => l.collAsset === "wstETH").slice(0, 1);
    const [r0] = whatIfRows(eth, "ETH", 0, T, BASE_PRICES);
    const [r30] = whatIfRows(eth, "ETH", 0.3, T, BASE_PRICES);
    expect(r30.hf).toBeCloseTo(r0.hf * 0.7);
    expect(whatIfRows(eth, "WBTC", 0.5, T, BASE_PRICES)[0].hf).toBeCloseTo(r0.hf);
  });
  it("hypotheticalLoan is Healthy at 0% and worse when the price falls", () => {
    const bal = { ETH: 20, wstETH: 0, WBTC: 0 };
    expect(hypotheticalLoan(10000, "ETH", 0, bal, "ethereum", BASE_PRICES, VENUES)!.status).toBe("healthy");
    expect(hypotheticalLoan(10000, "ETH", 0.6, bal, "ethereum", BASE_PRICES, VENUES)!.status).toBe("liquidatable");
    expect(hypotheticalLoan(10000, "ETH", 0, bal, "ethereum", BASE_PRICES, VENUES)!.liqPrice).toBeLessThan(BASE_PRICES.ETH);
    expect(hypotheticalLoan(10000, "ETH", 0, { ETH: 0.1, wstETH: 0, WBTC: 0 }, "ethereum", BASE_PRICES, VENUES)).toBeNull();
  });
  it("holdingRows lists only held assets per network with a per-asset max", () => {
    const z = { ETH: 0, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 };
    const rows = holdingRows({ ethereum: { ...z, ETH: 8, WBTC: 1 }, base: { ...z, ETH: 2, USDC: 500 } }, BASE_PRICES, NETWORKS, VENUES);
    expect(rows.map((r) => `${r.asset}@${r.network}`)).toEqual(["ETH@ethereum", "WBTC@ethereum", "ETH@base"]);
    expect(rows[0].max).toBeGreaterThan(0);
    expect(rows[0].max).toBeLessThan(8 * BASE_PRICES.ETH);
    expect(rows[2].max).toBeLessThan(rows[0].max); // Base has no Spark and holds less
  });

  it("uses each injected price and market without leaking between calls", () => {
    const balances = { ETH: 20, wstETH: 0, WBTC: 0 };
    const changedMarket = VENUES.map((venue) => venue.id === "aave"
      ? { ...venue, markets: { ...venue.markets, ETH: { maxLtv: 0.3, lt: 0.4 } } }
      : venue,
    );
    const onlyChangedMarket = changedMarket.filter((venue) => venue.id === "aave");
    const lowPrice = hypotheticalLoan(10000, "ETH", 0, balances, "ethereum", { ...BASE_PRICES, ETH: 1000 }, onlyChangedMarket);
    const highPrice = hypotheticalLoan(10000, "ETH", 0, balances, "ethereum", { ...BASE_PRICES, ETH: 2000 }, VENUES);
    expect(lowPrice).toBeNull();
    expect(highPrice).not.toBeNull();
    expect(hypotheticalLoan(10000, "ETH", 0, balances, "ethereum", { ...BASE_PRICES, ETH: 1000 }, onlyChangedMarket)).toEqual(lowPrice);
    expect(holdingRows({ ethereum: { ETH: 2, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 } }, { ...BASE_PRICES, ETH: 1000 }, NETWORKS, VENUES)[0].value).toBe(2000);
  });
});
