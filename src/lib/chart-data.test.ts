import { describe, expect, it } from "vitest";
import { hfHistory, historyLabel, priceDropSeries } from "./chart-data";
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

describe("hfHistory", () => {
  const trend = { start: 1.7, wave: 0.05 };
  it("differs only in the last point when the live value changes", () => {
    const a = hfHistory(trend, 1.45, 1.09), b = hfHistory(trend, 1.45, 1.45);
    expect(a).toHaveLength(31);
    expect(a[0].day).toBe(-30);
    expect(a[30].day).toBe(0);
    expect(a.slice(0, 30)).toEqual(b.slice(0, 30));
    expect(a[30].hf).toBe(1.09);
    expect(b[30].hf).toBe(1.45);
  });
  it("is empty without a trend or finite values", () => {
    expect(hfHistory(undefined, 1.4, 1.4)).toEqual([]);
    expect(hfHistory(trend, Infinity, Infinity)).toEqual([]);
  });
});

describe("historyLabel", () => {
  it("reads out the chart", () => {
    expect(historyLabel(1.18, 1.18, { warn: 1.6, act: 1.35 }))
      .toBe("Health factor 1.18 now, lowest 1.18 in 30 days. Warning at 1.6, action at 1.35, liquidated below 1.0.");
    expect(historyLabel(2.09, 1.95, { warn: 1.6, act: 1.35 }))
      .toBe("Health factor 2.09 now, lowest 1.95 in 30 days. Warning at 1.6, action at 1.35, liquidated below 1.0.");
  });
});
