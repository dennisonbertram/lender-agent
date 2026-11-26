import { describe, expect, it } from "vitest";
import { limitWhy, wasNowLine } from "./borrow-limit";

describe("limitWhy", () => {
  it("is one plain sentence naming the safety level and the lender", () => {
    expect(limitWhy({ max: 4000, lenderId: "morpho-blue", lenderName: "Morpho", asset: "ETH" }, "Balanced")).toBe(
      "Why $4,000? It is the most you can borrow against your ETH at the Balanced safety level, from Morpho, the lender that allows the most.",
    );
  });
  it("is empty when there is no limit", () => {
    expect(limitWhy({ max: 0, lenderId: null, lenderName: null, asset: null }, "Balanced")).toBe("");
  });
});

describe("wasNowLine", () => {
  it("says was and now with both lenders' figures", () => {
    expect(wasNowLine({ lender: "Morpho", apr: 3.4, yearly: 17 }, { lender: "Aave v3", apr: 5.5, yearly: 39 })).toBe(
      "Was about $17 a year at 3.4% with Morpho; now about $39 a year at 5.5% with Aave v3.",
    );
  });
});
