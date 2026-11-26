import { describe, expect, it } from "vitest";
import { BALANCES } from "@/data";
import { routeIntent } from "./intents";

const ctx = { hasLoans: false, balances: BALANCES, maxCash: () => 7500 };
const unfunded = { ...ctx, maxCash: () => 0 };
const block = (t: string, c = ctx) => routeIntent(t, c)?.block;

describe("routeIntent", () => {
  it.each(["close this loan", "refinance it", "edit the draft", "why morpho?", "what does the reserve do"])("leaves %s to the existing router", (t) => {
    expect(routeIntent(t, ctx)).toBeNull();
  });
  it("what if -> whatif", () => {
    expect(block("what if eth drops 30%")).toMatchObject({ kind: "whatif", asset: "ETH" });
    expect(block("What happens if prices drop?")?.kind).toBe("whatif");
    expect(block("crash?")?.kind).toBe("whatif");
  });
  it("how much could I borrow -> holdings", () => {
    expect(block("how much could i borrow")).toEqual({ kind: "holdings" });
    expect(block("What can I borrow?")).toEqual({ kind: "holdings" });
  });
  it("compare / lender / rate / offer -> compare", () => {
    expect(block("Compare lenders")).toEqual({ kind: "compare", cash: 7500 });
    expect(block("any offers for $25k")).toMatchObject({ kind: "compare", cash: 7500 });
    expect(block("what is the best rate")?.kind).toBe("compare");
  });
  it("an amount or need/borrow/cash/loan -> plan", () => {
    expect(block("I need $12k")).toMatchObject({ kind: "plan", cash: 12000 });
    expect(block("I need $10,000")).toMatchObject({ kind: "plan", cash: 10000 });
    expect(block("Borrow $7,500")).toMatchObject({ kind: "plan", cash: 7500 });
    expect(block("Borrow $10k")).toMatchObject({ kind: "plan", cash: 10000 });
    expect(block("I want cash")).toMatchObject({ kind: "plan", cash: 7500 });
    expect(block("15000")).toMatchObject({ kind: "plan", cash: 15000 });
  });
  it("explain topics", () => {
    expect(block("explain health factor")).toEqual({ kind: "explain", topic: "health" });
    expect(block("How does this work?")).toEqual({ kind: "explain", topic: "how" });
    expect(block("what is liquidation")).toEqual({ kind: "explain", topic: "liquidation" });
    expect(block("what is collateral")).toEqual({ kind: "explain", topic: "collateral" });
    expect(block("what is a safe wallet")).toEqual({ kind: "explain", topic: "safe" });
  });
  it("status", () => {
    expect(block("how am i doing")).toEqual({ kind: "status" });
    expect(block("my loans")).toEqual({ kind: "status" });
    expect(block("status")).toEqual({ kind: "status" });
  });
  it("anything else -> suggestions with the starter items", () => {
    const r = routeIntent("hello", ctx)!;
    expect(r.text).toBe("I can plan a loan, compare lenders, show what a price drop would do, or explain how this works.");
    expect(r.block).toMatchObject({ kind: "suggestions" });
    expect((r.block as { items: string[] }).items).toHaveLength(3);
  });
  it("every block reply has a lead sentence", () => {
    expect(routeIntent("I need $12k", ctx)?.text).toBe("Here is a plan. Change anything below.");
    expect(routeIntent("I need $15,000", ctx)?.text).not.toMatch(/\$\d/);
    expect(routeIntent("Compare lenders", ctx)?.text).toBe("Here are the lenders.");
  });
  it("an unfunded Safe is sent to add funds, not to a plan", () => {
    for (const t of ["I need $10,000", "Compare lenders", "How much could I borrow?", "Add funds"]) {
      expect(routeIntent(t, unfunded)).toEqual({ text: "First add crypto to borrow against. Send it to this address.", block: { kind: "addfunds" } });
    }
    expect(block("How does this work?", unfunded)).toEqual({ kind: "explain", topic: "how" });
    expect(routeIntent("add funds", ctx)).toEqual({ text: "Send more to this address.", block: { kind: "addfunds" } });
  });
});
