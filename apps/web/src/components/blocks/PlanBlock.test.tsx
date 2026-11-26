// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanBlock, type PlanBlockProps, type PlanQuote } from "./PlanBlock";
import { LimitWhy } from "./LimitWhy";

const quote: PlanQuote = { kind: "ok", cash: 5000, borrowAsset: "USDC", asset: "ETH", collateral: 2.09, collateralUsd: 6270, price: 3000, liqPrice: 1930, dropPct: 36, adding: false, apr: 5.5, yearly: 39, feesLine: "fee", lender: "Aave v3", network: "Base" };
const base = (over: Partial<PlanBlockProps> = {}): PlanBlockProps => ({ block: { kind: "plan", cash: 5000 }, maxCash: 9000, cashText: "$5,000", safetyIdx: 1, onCashText: () => {}, onSafety: () => {}, quote, onSend: () => {}, ...over });

afterEach(cleanup);

describe("PlanBlock previous", () => {
  it("shows one bordered Was/now note when a previous lender is given", () => {
    render(<PlanBlock {...base({ previous: { lender: "Morpho", apr: 3.4, yearly: 17 } })} />);
    const n = screen.getByText("Was about $17 a year at 3.4% with Morpho; now about $39 a year at 5.5% with Aave v3.");
    expect(n.className).toContain("border");
  });
  it("shows none without it", () => {
    render(<PlanBlock {...base()} />);
    expect(screen.queryByText(/^Was about/)).toBeNull();
  });
});

describe("LimitWhy", () => {
  it("toggles the sentence and aria-expanded", () => {
    render(<LimitWhy why="Why $4,000? It is the most." />);
    const b = screen.getByRole("button", { name: "Why $4,000?" });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("It is the most.")).toBeNull();
    fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("It is the most.")).toBeTruthy();
  });
});

describe("PlanBlock hypothetical", () => {
  const hyp = () => base({ block: { kind: "plan", cash: 100000, hypothetical: true }, onAffordable: () => {} });
  it("is read-only: no amount input, chips, picker or Send; neutral note; affordable chip", () => {
    render(<PlanBlock {...hyp()} />);
    expect(screen.queryByLabelText("Cash you need")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(screen.getByText("at Balanced safety")).toBeTruthy();
    const note = screen.getByText("This shows what that amount would need. Nothing is sent.");
    expect(note.className).not.toContain("destructive");
    expect(screen.getByRole("button", { name: "Plan a loan I can afford" })).toBeTruthy();
  });
});

describe("PlanBlock figures", () => {
  it("says less than $1 a year instead of about $0", () => {
    render(<PlanBlock {...base({ quote: { ...quote, yearly: 0.3 } })} />);
    expect(screen.getByText("Less than $1 a year at 5.5%. The rate can change.")).toBeTruthy();
  });
  it("safety segments and chips are at least 44px tall", () => {
    render(<PlanBlock {...base()} />);
    expect(screen.getByText("Balanced").closest("label")!.className).toContain("min-h-11");
    expect(screen.getAllByRole("button")[0].className).toContain("min-h-11");
  });
});
