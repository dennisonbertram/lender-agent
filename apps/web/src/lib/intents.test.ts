import { describe, expect, it } from "vitest";
import { BALANCES } from "../../tests/fixtures/legacy-data";
import { routeIntent, type IntentCtx } from "./intents";

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
  it("a typed percentage reaches the what-if block", () => {
    expect(block("what if ETH falls 30%")).toEqual({ kind: "whatif", asset: "ETH", drop: 30 });
    expect(block("what if ETH drops 33 percent")).toMatchObject({ kind: "whatif", drop: 35 });
    expect(block("what if ETH falls 80%")).toMatchObject({ kind: "whatif", drop: 60, capped: true });
    expect(block("what if ETH falls 60%")).not.toHaveProperty("capped");
    expect(block("what happens if prices drop?")).not.toHaveProperty("drop");
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
    expect(block("I want the most cash")).toMatchObject({ kind: "plan", cash: 7500 });
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
  it("the fallback chips offer no Borrow while a loan is at risk", () => {
    const r = routeIntent("hello", { ...ctx, urgent: { lender: "Aave v3", loanId: "L1" } })!;
    expect((r.block as { items: string[] }).items).toEqual(["Fix my Aave v3 loan", "How does this work?"]);
    expect((routeIntent("hello", ctx)!.block as { items: string[] }).items.some((c) => /^Borrow/.test(c))).toBe(true);
  });
});

describe("sizing questions are hypothetical, never a sendable plan", () => {
  it.each(["What would it take for $50,000?", "how much collateral for $100k", "How much would I need to borrow $50,000?"])("%s -> hypothetical plan", (t) => {
    expect(routeIntent(t, ctx)?.block).toMatchObject({ kind: "plan", hypothetical: true });
  });
  it("the amount is kept", () => {
    expect(routeIntent("What would it take for $50,000?", ctx)?.block).toMatchObject({ cash: 50000 });
  });
  it("a Safe with nothing in it still gets the sizing answer", () => {
    expect(routeIntent("what would it take for $50,000?", { ...ctx, maxCash: () => 0 })?.block).toMatchObject({ kind: "plan", hypothetical: true });
  });
});

describe("fix my loan", () => {
  const urgent = { lender: "Morpho", loanId: "8453:0xabc:morpho-blue" };
  it.each(["Fix my Morpho loan", "Fix my Aave v3 loan", "fix my loan", "Protect my loan"])("%s opens the fix options, never a plan", (t) => {
    expect(routeIntent(t, { ...ctx, urgent })?.block).toEqual({ kind: "fix", loanId: urgent.loanId });
  });
});

describe("with an open loan (R1, F-01, F-02, F-04, F-06)", () => {
  const withLoan: IntentCtx = { ...ctx, hasLoan: true };
  const r = (t: string, c: typeof withLoan = withLoan) => routeIntent(t, c)!;
  it.each(["How is my loan doing?", "Am I ok?", "how's my loan"])("%s -> the status card", (t) => {
    expect(r(t).block).toEqual({ kind: "status" });
  });
  it("interest -> the loan, not a new plan", () => {
    expect(r("How much interest am I paying?").block).toEqual({ kind: "status" });
  });
  it("can I borrow more -> a top-up that says so", () => {
    const x = r("Can I borrow $500 more?");
    expect(x.block).toMatchObject({ kind: "plan", cash: 500 });
    expect(x.text).toMatch(/adds to your existing loan/);
    expect(r("can I borrow more").block).toMatchObject({ kind: "plan", cash: 7500 });
  });
  it("fix my loan in the Watch range -> says so and offers fix options", () => {
    const x = r("Fix my loan", { ...withLoan, standing: { status: "watch", health: 1.4, loanId: "L1" } });
    expect(x.text).toMatch(/Watch range \(health 1\.40\); here are ways to add margin/);
    expect(x.text).not.toMatch(/nothing to fix/);
    expect(x.block).toEqual({ kind: "fix", loanId: "L1" });
  });
  it.each([undefined, { status: "unknown" as const }])("fix my loan with the status unknown -> never 'healthy', the status card", (standing) => {
    const x = r("Fix my loan", { ...withLoan, standing });
    expect(x.text).not.toMatch(/healthy; nothing/);
    expect(x.block?.kind).toBe("status");
  });
  it("fix my loan on a healthy loan -> nothing to fix, no plan", () => {
    const x = r("Fix my loan", { ...withLoan, standing: { status: "healthy", health: 2 } });
    expect(x.text).toMatch(/healthy; nothing to fix/);
    expect(x.block?.kind).toBe("suggestions");
  });
  it.each(["How do I pay it back?", "how do I close it", "can I repay early?"])("%s -> repay any time, no penalty, link to the loan", (t) => {
    const x = r(t);
    expect(x.text).toMatch(/repay any time, with no penalty/);
    expect(x.block).toEqual({ kind: "status" });
  });
  it("answers without figures", () => {
    for (const t of ["How is my loan doing?", "How much interest am I paying?", "How do I pay it back?", "Fix my loan"]) expect(r(t).text).not.toMatch(/\d/);
  });
  it("keeps exact cents in the scripted repayment guidance", () => {
    expect(r("How do I repay $200.51?").text).toContain("type $200.51");
  });
});

describe("scripted dead ends (F-04, F-06)", () => {
  it("who can move my funds -> the Safe's owners, by approving", () => {
    for (const t of ["Who can move my funds?", "can the agent take my money?"]) {
      const x = routeIntent(t, ctx)!;
      expect(x.block).toEqual({ kind: "explain", topic: "safe" });
      expect(x.text).toMatch(/owners.*approving/);
    }
  });
  it("what's in my Safe / with numbers -> holdings", () => {
    expect(block("What's in my Safe?")).toEqual({ kind: "holdings" });
    expect(block("Show me with numbers")).toEqual({ kind: "holdings" });
  });
  it("I need money, no amount -> asks how much, with chips", () => {
    const x = routeIntent("I need money", ctx)!;
    expect(x.text).toBe("How much do you need?");
    expect((x.block as { items: string[] }).items[0]).toBe("Borrow $7,500");
    expect(block("I need $3,000")).toMatchObject({ kind: "plan", cash: 3000 });
  });
});
