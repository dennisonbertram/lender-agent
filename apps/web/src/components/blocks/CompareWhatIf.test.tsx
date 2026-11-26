// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CompareBlock } from "./CompareBlock";
import { WhatIfBlock } from "./WhatIfBlock";

afterEach(cleanup);

const rows = [
  { venueId: "aave-v3", lender: "Aave v3", feasible: true, apr: 3.4, yearly: 340, dropPct: 37, status: "healthy" as const, liqPrice: 1720, collateral: 6.12, adding: false },
  { venueId: "spark", lender: "Spark", feasible: false, apr: 3.9, reason: "Can lend up to $6,000 against your ETH.", limit: 6000 },
];

describe("CompareBlock", () => {
  it("prints the server's figures per feasible row and mutes the infeasible one with its reason", () => {
    render(<CompareBlock cash={10000} asset="ETH" network="Base" rows={rows} onUse={() => {}} />);
    expect(screen.getByText("$10,000 against your ETH on Base, Balanced safety")).toBeTruthy();
    expect(screen.getByText("About $340 in interest a year")).toBeTruthy();
    expect(screen.getByText("Price can fall 37%")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    const reason = screen.getByText("Can lend up to $6,000 against your ETH.");
    expect(reason.closest("li")!.className).toContain("text-muted-foreground");
    expect(screen.queryByRole("button", { name: "Use Spark" })).toBeNull();
  });
  it("Plan this calls onUse with the venue", () => {
    const onUse = vi.fn();
    render(<CompareBlock cash={10000} asset="ETH" network="Base" rows={rows} onUse={onUse} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan this with Aave v3" }));
    expect(onUse).toHaveBeenCalledWith("aave-v3");
    expect(screen.queryByRole("button", { name: /^Use/ })).toBeNull();
  });
});

const feasible = (venueId: string, lender: string, apr: number, yearly: number, over = {}) => ({ venueId, lender, feasible: true, apr, yearly, dropPct: 38, status: "healthy" as const, liqPrice: 1900, collateral: 1, adding: false, ...over });
describe("CompareBlock shared facts (VC-08)", () => {
  const three = [feasible("morpho", "Morpho", 2.9, 29), feasible("aave-v3", "Aave v3", 3.4, 34), feasible("spark", "Spark", 3.6, 36)];
  it("says shared facts once, marks the best row, one primary button", () => {
    render(<CompareBlock cash={1000} asset="ETH" network="Base" rows={three} bestId="morpho" onUse={() => {}} />);
    expect(screen.getByText(/Same with all three: ETH can fall 38% before the lender can sell it/)).toBeTruthy();
    expect(screen.getAllByText("Healthy")).toHaveLength(1);
    expect(screen.queryByText(/Price can fall/)).toBeNull();
    expect(screen.getAllByText("Lowest rate")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Plan this/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Plan this with Morpho" }).className).not.toContain("border-border");
    expect(screen.getByRole("button", { name: "Plan this with Spark" }).className).toContain("border");
  });
  it("keeps per-row facts when they differ", () => {
    render(<CompareBlock cash={1000} asset="ETH" network="Base" rows={[three[0], feasible("spark", "Spark", 3.6, 36, { dropPct: 30 })]} bestId="morpho" onUse={() => {}} />);
    expect(screen.queryByText(/Same with/)).toBeNull();
    expect(screen.getByText("Price can fall 38%")).toBeTruthy();
    expect(screen.getByText("Price can fall 30%")).toBeTruthy();
  });
  it("says both for two rows", () => {
    render(<CompareBlock cash={1000} asset="ETH" network="Base" rows={three.slice(0, 2)} bestId="morpho" onUse={() => {}} />);
    expect(screen.getByText(/Same with both:/)).toBeTruthy();
  });
});

const steps = (hfs: number[], statuses: ("healthy" | "watch" | "risk" | "liquidatable")[]) => [0, 20, 30, 40].map((drop, i) => ({ drop, hf: hfs[i], status: statuses[i], price: Math.round(3000 * (1 - drop / 100)) }));

describe("WhatIfBlock", () => {
  const loans = [{ id: "l1", lender: "Aave v3", venueId: "aave-v3", chainId: 8453 as const, network: "base" as const, collAsset: "ETH" as const, moves: true, steps: steps([2.1, 1.7, 1.4, 1.2], ["healthy", "healthy", "watch", "risk"]) }];
  it("shows each loan's health and status for the slider step", () => {
    render(<WhatIfBlock asset="ETH" price={3000} loans={loans} hypothetical={null} cash={10000} />);
    expect(screen.getByText("If ETH falls 20%")).toBeTruthy();
    expect(screen.getByText("1.70")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
    expect(screen.getByText("If ETH falls 40%")).toBeTruthy();
    expect(screen.getByText("1.20")).toBeTruthy();
    expect(screen.getByText("At risk")).toBeTruthy();
  });
  it("with no loans says what a hypothetical loan would be and its liquidation price", () => {
    const hypothetical = { cash: 10000, lender: "Aave v3", venueId: "aave-v3", liqPrice: 1720, steps: steps([1.6, 1.3, 1.1, 0.9], ["healthy", "risk", "risk", "liquidatable"]) };
    render(<WhatIfBlock asset="ETH" price={3000} loans={[]} hypothetical={hypothetical} cash={10000} />);
    expect(screen.getByText("It is liquidated if ETH falls below $1,720.")).toBeTruthy();
    expect(screen.getByText(/assuming a \$10,000 loan/)).toBeTruthy();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
    expect(screen.getByText("Can be liquidated")).toBeTruthy();
  });
  it("starts at the asked drop", () => {
    render(<WhatIfBlock asset="ETH" price={3000} loans={loans} hypothetical={null} cash={10000} initialDrop={30} />);
    expect(screen.getByText("If ETH falls 30%")).toBeTruthy();
    expect(screen.getByText(/After this fall: about \$2,100\./)).toBeTruthy();
    expect(screen.queryByText("This tries falls up to 60%.")).toBeNull();
  });
  it("calculates the selected network asset price instead of reusing another loan's price", () => {
    const otherNetworkLoan = [{ ...loans[0], steps: steps([2.1, 1.7, 1.4, 1.2], ["healthy", "healthy", "watch", "risk"]).map((s) => ({ ...s, price: 2000 })) }];
    render(<WhatIfBlock asset="ETH" price={4000} loans={otherNetworkLoan} hypothetical={null} cash={10000} initialDrop={20} />);
    expect(screen.getByText(/After this fall: about \$3,200\./)).toBeTruthy();
  });
  it("says so when the asked fall was above the slider's range", () => {
    render(<WhatIfBlock asset="ETH" price={3000} loans={loans} hypothetical={null} cash={10000} initialDrop={60} capped />);
    expect(screen.getByText("This tries falls up to 60%.")).toBeTruthy();
  });
  it("shows the hypothetical verdict as a status pill (dot and colour)", () => {
    const hypothetical = { cash: 4000, lender: "Aave v3", venueId: "aave-v3", liqPrice: 1720, steps: steps([1.6, 1.3, 1.1, 0.9], ["healthy", "risk", "risk", "liquidatable"]) };
    render(<WhatIfBlock asset="ETH" price={3000} loans={[]} hypothetical={hypothetical} cash={4000} initialDrop={20} />);
    const verdict = screen.getByText("At risk");
    expect(verdict.className).toContain("text-destructive-text");
    expect(verdict.querySelector("span[aria-hidden]")).not.toBeNull();
  });
  it("never says prices are sample data", () => {
    render(<WhatIfBlock asset="ETH" price={3000} loans={loans} hypothetical={null} cash={10000} />);
    expect(screen.getByText(/^ETH is \$3,000 now\./)).toBeTruthy();
    expect(screen.queryByText(/sample data/i)).toBeNull();
  });
  it("an empty Safe gets a sentence and no slider", () => {
    render(<WhatIfBlock asset="ETH" price={3000} loans={[]} hypothetical={null} cash={0} />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByText(/falls/)).toBeNull();
    expect(screen.getByText("Add crypto to this Safe to see what a price fall would do to a loan.")).toBeTruthy();
  });
  it("a loan the Safe cannot back says so, still with no slider", () => {
    render(<WhatIfBlock asset="ETH" price={3000} loans={[]} hypothetical={null} cash={10000} />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByText("This Safe cannot safely back $10,000 with ETH.")).toBeTruthy();
  });
});
