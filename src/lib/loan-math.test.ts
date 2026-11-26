import { describe, expect, it } from "vitest";
import { healthFactor, healthStatus, hfAfterDrop, liquidationPrice, maxPriceDrop, maxSafeBorrow, parseAmount, parseNumber, levelErrors, reservePlan, attentionOf, type HealthStatus, parseLevels, levelsOf, DEFAULT_LEVELS } from "./loan-math";
import { BALANCES, PRICES, VENUES, type Asset } from "../data";

it("computes health factor and liquidation price", () => {
  // 20 ETH at $2,745, LT 0.82, debt 38,000
  const hf = healthFactor(20 * 2745, 0.82, 38000);
  expect(hf).toBeCloseTo(1.185, 3);
  const liq = liquidationPrice(20, 0.82, 38000);
  expect(liq).toBeCloseTo(2317.07, 1);
  // At the liquidation price the health factor is 1.
  expect(healthFactor(20 * liq, 0.82, 38000)).toBeCloseTo(1, 6);
  expect(hfAfterDrop(hf, 0.5)).toBeCloseTo(hf / 2, 6);
  expect(healthStatus(1.18, 1.6, 1.35)).toBe("risk");
  expect(healthStatus(0.89, 1.6, 1.35)).toBe("liquidatable");
  expect(healthStatus(1.0, 1.6, 1.35)).toBe("risk");
  expect(healthStatus(1.45, 1.6, 1.35)).toBe("watch");
  expect(healthStatus(2.1, 1.6, 1.35)).toBe("healthy");
});

describe("reservePlan", () => {
  // Morpho loan after WBTC falls 25%: HF about 1.09, below the 1.10 trigger.
  const loan = { amount: 0.9, price: 74900 * 0.75, lt: 0.86, debt: 40000 };
  const bal = { coll: 0, stable: 15000 };
  const policy = { armed: true, emergencyHF: 1.1, dailyCapUsd: 15000, usedUsd24h: 0 };

  it("tops up to the target health factor", () => {
    const plan = reservePlan(loan, 1.6, bal, policy)!;
    expect(plan.hfAfter).toBeCloseTo(1.6, 6);
    expect(plan.unmet).toBe(false);
    expect(plan.repay).toBeGreaterThan(0);
  });

  it("stops at the daily cap", () => {
    const plan = reservePlan(loan, 1.6, bal, { ...policy, dailyCapUsd: 5000 })!;
    expect(plan.usd).toBeCloseTo(5000, 6);
    expect(plan.unmet).toBe(true);
    expect(plan.hfAfter).toBeLessThan(1.6);
  });

  it("does nothing when paused or above the trigger", () => {
    expect(reservePlan(loan, 1.6, bal, { ...policy, armed: false })).toBeNull();
    const healthy = { ...loan, price: 74900 };
    expect(reservePlan(healthy, 1.6, bal, policy)).toBeNull();
    expect(reservePlan(healthy, 1.6, bal, policy, true)).not.toBeNull();
  });
});

describe("maxSafeBorrow", () => {
  it("matches the judged examples", () => {
    expect(maxSafeBorrow(21960, 0.83, 0.805, 1.35)).toBe(13500);
    expect(maxSafeBorrow(21960, 0.9, 0.83, 1.35)).toBe(14500);
    expect(maxSafeBorrow(37450, 0.75, 0.7, 1.35)).toBe(20500);
    expect(maxSafeBorrow(10000, 0.9, 0.5, 1.35)).toBe(5000);
    expect(maxSafeBorrow(0, 0.83, 0.805, 1.35)).toBe(0);
  });
  it("keeps health >= 1.35 for every venue and asset", () => {
    for (const v of VENUES)
      for (const a of Object.keys(v.markets) as Asset[]) {
        const m = v.markets[a]!;
        const value = BALANCES[a] * PRICES[a];
        expect(healthFactor(value, m.lt, maxSafeBorrow(value, m.lt, m.maxLtv, 1.35))).toBeGreaterThanOrEqual(1.35);
      }
  });
});

it("maxPriceDrop", () => {
  expect(maxPriceDrop(2)).toBe(0.5);
  expect(maxPriceDrop(1)).toBe(0);
  expect(maxPriceDrop(0.8)).toBe(0);
  expect(maxPriceDrop(Infinity)).toBe(1);
});

it("parseAmount", () => {
  expect(parseAmount("99", 8)).toEqual({ amount: 8, over: true });
  expect(parseAmount("3.5", 8)).toEqual({ amount: 3.5, over: false });
  for (const t of ["", "abc", "-3"]) expect(parseAmount(t, 8)).toEqual({ amount: 0, over: false });
  expect(parseAmount("1e3", 8)).toEqual({ amount: 0, over: false });
  expect(parseAmount("8", 8)).toEqual({ amount: 8, over: false });
});

describe("alert levels", () => {
  it("parses valid levels", () => expect(parseLevels("1.6", "1.35")).toEqual({ warn: 1.6, act: 1.35 }));
  it.each([["1.1", "1.5"], ["1.6", "1.6"], ["-3", "0.5"], ["1.5", "1"], ["", "1.35"], ["1.", "1.35"], ["abc", "1.2"]])(
    "rejects %s / %s", (w, a) => expect(parseLevels(w, a)).toBeNull());
  it("levelsOf falls back to defaults", () => {
    expect(levelsOf({}, "x")).toBe(DEFAULT_LEVELS);
    expect(levelsOf({ x: { warn: 2, act: 1.5 } }, "x")).toEqual({ warn: 2, act: 1.5 });
  });
});

import { parseUsd } from "./loan-math";
it("parseUsd", () => {
  expect(parseUsd("borrow $10k")).toBe(10000);
  expect(parseUsd("$12.5k")).toBe(12500);
  expect(parseUsd("make it $15,000 instead")).toBe(15000);
  expect(parseUsd("15000")).toBe(15000);
  expect(parseUsd("8 eth")).toBeNull();
  expect(parseUsd("close loan")).toBeNull();
});

describe("attentionOf", () => {
  const L = (hf: number, status: HealthStatus) => ({ hf, status });
  it("treasury shape", () => {
    const a = attentionOf([L(2.09, "healthy"), L(1.45, "watch"), L(1.18, "risk")]);
    expect(a.risk).toBe(1); expect(a.count).toBe(1); expect(a.worst?.hf).toBe(1.18);
  });
  it("watch only", () => {
    const a = attentionOf([L(1.45, "watch"), L(1.53, "watch")]);
    expect(a.risk).toBe(0); expect(a.count).toBe(2); expect(a.worst?.hf).toBe(1.45);
  });
  it("risk loan with a higher hf than a watch loan is still worst", () => {
    expect(attentionOf([L(1.2, "watch"), L(1.5, "risk")]).worst?.hf).toBe(1.5);
  });
  it("liquidatable counts as risk", () => expect(attentionOf([L(0.89, "liquidatable"), L(1.4, "watch")]).risk).toBe(1));
  it("nothing", () => {
    expect(attentionOf([L(2, "healthy")]).count).toBe(0);
    expect(attentionOf([]).worst).toBeUndefined();
  });
});

describe("parseNumber", () => {
  it.each([["1,8", 1.8], ["0,25", 0.25], ["$15,000", 15000], ["1,800", 1800], [" 2.5 ", 2.5], [".5", 0.5], ["99999999999999999999999", 1e23]])(
    "reads %s as %s", (t, n) => expect(parseNumber(t)).toBe(n));
  it.each(["", "abc", "1e3", "1.2.3", "-3", "10k"])("rejects %s", (t) => expect(parseNumber(t)).toBeNull());
});

describe("levelErrors", () => {
  it("accepts valid levels, including a decimal comma", () => {
    expect(levelErrors("1.6", "1.35")).toEqual({});
    expect(levelErrors("1,8", "1.35")).toEqual({});
  });
  it("names the field and the reason", () => {
    expect(levelErrors("1.6", "99999").act).toBe("At-risk level can be at most 5.0.");
    expect(levelErrors("99999999999999999999999", "1.35").warn).toBe("Watch level can be at most 5.0.");
    expect(levelErrors("", "1.35").warn).toBe("Enter Watch level.");
    expect(levelErrors("1.6", "1.8").act).toBe("At-risk level must be below Watch level.");
    expect(levelErrors("1.6", "1").act).toBe("At-risk level must be above 1.0.");
    expect(levelErrors("1.6", "x").act).toBe("Use numbers only, for example 1.6.");
  });
  it("parseLevels rejects out-of-range values", () => expect(parseLevels("99999", "1.35")).toBeNull());
});

describe("level names (r24)", () => {
  it("uses Watch level and At-risk level", () => {
    expect(levelErrors("1.3", "1.4").act).toBe("At-risk level must be below Watch level.");
    expect(levelErrors("", "1.35").warn).toBe("Enter Watch level.");
  });
});
