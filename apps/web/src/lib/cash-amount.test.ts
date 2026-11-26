import { describe, expect, it } from "vitest";
import { checkAmount, parseCash } from "./cash-amount";

describe("parseCash", () => {
  it.each([["10k", 10000], ["$10,000", 10000], ["500", 500], [" 2.5k ", 2500]])("%s -> %d", (t, n) => expect(parseCash(t)).toBe(n));
  it.each(["", "abc", "0", "-5"])("%j -> null", (t) => expect(parseCash(t)).toBeNull());
});

describe("checkAmount", () => {
  it("empty: the hint with the range, not an error", () => {
    expect(checkAmount("", 9000)).toEqual({ ok: false, cash: null, message: "With what's in this Safe you can borrow $10 to $9,000.", tone: "hint" });
    expect(checkAmount("   ", 9000).ok).toBe(false);
  });
  it("not a number: numbers only", () => {
    expect(checkAmount("abc", 9000)).toMatchObject({ ok: false, cash: null, tone: "error", message: "Use numbers only, for example $5,000." });
  });
  it("below the smallest loan", () => {
    expect(checkAmount("5", 9000)).toMatchObject({ ok: false, cash: 5, tone: "error", message: "The smallest loan is $10." });
  });
  it("above the maximum: the most, and the Use chip amount", () => {
    expect(checkAmount("$12,000", 9000)).toEqual({ ok: false, cash: 12000, tone: "error", message: "That's more than this Safe can safely borrow against. The most is $9,000.", useMax: 9000 });
  });
  it("in range, and exactly the bounds, is ok", () => {
    expect(checkAmount("10k", 25000)).toMatchObject({ ok: true, cash: 10000 });
    expect(checkAmount("500", 9000).ok).toBe(true);
    expect(checkAmount("9000", 9000).ok).toBe(true);
  });
});
