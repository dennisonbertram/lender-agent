import { describe, expect, it } from "vitest";
import { priceDropSeries } from "./chart-data";
import { healthFactor, liquidationPrice } from "./loan-math";

describe("priceDropSeries", () => {
  it("matches the loan's liquidation price and nulls points below it", () => {
    const hf = healthFactor(20 * 2745, 0.82, 38000);
    const r = priceDropSeries(2745, hf)!;
    expect(r.liq).toBeCloseTo(liquidationPrice(20, 0.82, 38000), 4);
    expect(r.points[0].price).toBe(2745);
    expect(r.points[0].hf).toBeCloseTo(1.185, 3);
    expect(r.points.find((p) => Math.abs(p.price - r.liq) < 1e-6)!.hf).toBeCloseTo(1, 6);
    for (const p of r.points) if (p.price < r.liq - 1e-6) expect(p.hf).toBeNull();
    expect(r.low).toBeLessThan(r.liq);
    expect(r.points.some((p) => p.price < r.liq - 1e-6)).toBe(true);
  });

  it("scales the range with risk", () => {
    for (const hf of [1.09, 2.09]) {
      const r = priceDropSeries(1000, hf)!;
      expect((1000 - r.liq) / (1000 - r.low)).toBeCloseTo(2 / 3, 2);
    }
    const r = priceDropSeries(1000, 1.09)!;
    expect((1000 - r.liq) / (1000 - r.low)).toBeLessThan(0.7);
  });

  it("returns null at or below liquidation, and with no debt", () => {
    expect(priceDropSeries(100, 0.9)).toBeNull();
    expect(priceDropSeries(100, 1)).toBeNull();
    expect(priceDropSeries(100, Infinity)).toBeNull();
  });
});
