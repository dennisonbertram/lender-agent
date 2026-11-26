import { describe, expect, it } from "vitest";
import { fromUnits, toUnits, unitsDown, unitsUp } from "./units";

describe("units", () => {
  it("converts exact amounts at 6, 8 and 18 decimals", () => {
    expect(unitsDown(1000, 6)).toBe(1_000_000_000n);
    expect(unitsDown(1.5, 8)).toBe(150_000_000n);
    expect(unitsDown(0.1, 18)).toBe(100_000_000_000_000_000n);
    expect(unitsUp(0.1, 18)).toBe(100_000_000_000_000_000n); // no float noise
    expect(unitsUp(2.5, 6)).toBe(2_500_000n);
  });
  it("rounds down for borrow and withdraw, up for repay and supply-needed", () => {
    expect(unitsDown(1.2345678, 6)).toBe(1_234_567n);
    expect(unitsUp(1.2345678, 6)).toBe(1_234_568n);
    expect(unitsDown(0.123456789, 8)).toBe(12_345_678n);
    expect(unitsUp(0.123456789, 8)).toBe(12_345_679n);
    expect(unitsDown(1.0000000000000000019, 18)).toBe(1_000_000_000_000_000_000n);
    expect(toUnits(0.0000001, 6, "up")).toBe(1n);
    expect(toUnits(0.0000001, 6, "down")).toBe(0n);
  });
  it("handles exponent notation and rejects bad input", () => {
    expect(unitsDown(1e-7, 18)).toBe(100_000_000_000n);
    expect(unitsDown(1e21, 6)).toBe(10n ** 27n);
    expect(() => unitsDown(-1, 6)).toThrow();
    expect(() => unitsDown(NaN, 6)).toThrow();
  });
  it("converts back", () => {
    expect(fromUnits(1_234_567n, 6)).toBe(1.234567);
    expect(fromUnits(10n ** 18n, 18)).toBe(1);
    expect(fromUnits(150_000_000n, 8)).toBe(1.5);
  });
});
