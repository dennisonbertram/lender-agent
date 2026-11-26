// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AddFundsBlock } from "./AddFundsBlock";
import { Block } from "./Block";
import { ExplainBlock } from "./ExplainBlock";
import { HoldingsBlock } from "./HoldingsBlock";
import { PlanBlock, type PlanBlockProps, type PlanQuote } from "./PlanBlock";
import { StatusBlock } from "./StatusBlock";
import { SuggestionsBlock } from "./SuggestionsBlock";

afterEach(cleanup);

describe("ExplainBlock", () => {
  it("states the signature count for the Safe topic and offers no buttons", () => {
    render(<ExplainBlock block={{ kind: "explain", topic: "safe" }} needs={2} onSend={() => {}} />);
    expect(screen.getByText("A Safe is a shared wallet. Transactions need 2 owner signatures. I can only suggest them.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("draws the health scale with the alert levels and sends follow-ups", () => {
    const onSend = vi.fn();
    render(<ExplainBlock block={{ kind: "explain", topic: "health" }} needs={1} levels={{ warn: 1.7, act: 1.4 }} onSend={onSend} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("needs action below 1.4, comfortable above 1.7");
    fireEvent.click(screen.getByRole("button", { name: "Show me with numbers" }));
    expect(onSend).toHaveBeenCalledWith("Show me with numbers");
  });
  it("offers a plan button on the how topic when the Safe can borrow", () => {
    const onSend = vi.fn();
    render(<ExplainBlock block={{ kind: "explain", topic: "how" }} needs={1} maxCash={25000} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan $10,000" }));
    expect(onSend).toHaveBeenCalledWith("Borrow $10,000");
  });
});

describe("StatusBlock", () => {
  it("says there are no loans and offers a plan when funds allow", () => {
    const onSend = vi.fn();
    render(<StatusBlock loans={[]} maxCash={5000} onOpenLoan={() => {}} onSend={onSend} />);
    expect(screen.getByText("You have no loans yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan a loan" }));
    expect(onSend).toHaveBeenCalled();
  });
  it("asks for funds when the Safe is too small", () => {
    render(<StatusBlock loans={[]} maxCash={5} onOpenLoan={() => {}} onSend={() => {}} />);
    expect(screen.getByText("Add funds to plan a loan.")).toBeTruthy();
  });
  it("shows the rate and yearly cost on each row", () => {
    render(<StatusBlock loans={[{ id: "a", venue: "Morpho", hf: 2.1, status: "healthy", dropPct: 52, apr: 3.4, yearly: 34 }]} maxCash={0} onOpenLoan={() => {}} onSend={() => {}} />);
    expect(screen.getByText("3.4% · about $34 a year")).toBeTruthy();
  });
  it("lists loans and opens one", () => {
    const onOpenLoan = vi.fn();
    render(<StatusBlock loans={[{ id: "a", venue: "Aave v3", hf: 2.1, status: "healthy", dropPct: 52 }]} maxCash={0} onOpenLoan={onOpenLoan} onSend={() => {}} />);
    expect(screen.getByText("can fall 52%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Aave v3 loan" }));
    expect(onOpenLoan).toHaveBeenCalledWith("a");
  });
});

describe("HoldingsBlock", () => {
  it("shows the empty copy", () => {
    render(<HoldingsBlock rows={[]} onSend={() => {}} />);
    expect(screen.getByText("This Safe holds no ETH or wstETH yet. Add some and I can plan a loan.")).toBeTruthy();
  });
  it("shows rows, a network chip once, and no sample-data line", () => {
    const onSend = vi.fn();
    render(<HoldingsBlock rows={[
      { network: "base", asset: "ETH", amount: 2, value: 6000, max: 3000 },
      { network: "base", asset: "WBTC", amount: 0.001, value: 60, max: 5 },
    ]} onSend={onSend} />);
    expect(screen.getAllByText("Base")).toHaveLength(1);
    expect(screen.getByText("Borrow up to $3,000 at Balanced safety")).toBeTruthy();
    expect(screen.getByText("Too little to borrow $10 safely")).toBeTruthy();
    expect(screen.queryByText(/sample data/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan with ETH" }));
    expect(onSend).toHaveBeenCalled();
  });
});

describe("HoldingsBlock Plan with", () => {
  it("plans the row's own max through onPlan, never a model-parsed amount (production: card said $13, plan said $195)", () => {
    const onSend = vi.fn();
    const onPlan = vi.fn();
    render(<HoldingsBlock rows={[{ network: "base", asset: "ETH", amount: 0.0146, value: 26, max: 13 }]} onSend={onSend} onPlan={onPlan} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan with ETH" }));
    expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({ asset: "ETH", max: 13 }), 13);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("AddFundsBlock", () => {
  it("shows the address and networks, with no demo deposit", () => {
    render(<AddFundsBlock address="0xabc" networks={["base"]} />);
    expect(screen.getByText("0xabc")).toBeTruthy();
    expect(screen.getByText("Send ETH or wstETH to this address. These are what you can borrow against on Base.")).toBeTruthy();
    expect(screen.queryByText(/simulate|demo/i)).toBeNull();
  });

  it("has a Copy button that copies the address, and names the networks", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AddFundsBlock address="0xabc" networks={["base"]} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("0xabc");
    expect(screen.getByText("Same address on each of these networks:")).toBeTruthy();
    expect(screen.getByText("Base")).toBeTruthy();
  });
});

describe("SuggestionsBlock", () => {
  it("sends the chip text and can be disabled", () => {
    const onSend = vi.fn();
    const block: { kind: "suggestions"; items: string[] } = { kind: "suggestions", items: ["How does this work?"] };
    const { rerender } = render(<SuggestionsBlock block={block} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "How does this work?" }));
    expect(onSend).toHaveBeenCalledWith("How does this work?");
    rerender(<SuggestionsBlock block={block} disabled onSend={onSend} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Block", () => {
  it("renders the renderer for the kind and nothing for kinds without one", () => {
    const { container, rerender } = render(<Block block={{ kind: "status" }} render={{ status: () => <p>status here</p> }} />);
    expect(screen.getByText("status here")).toBeTruthy();
    rerender(<Block block={{ kind: "whatif" }} render={{}} />);
    expect(container.textContent).toBe("");
  });
});

const ok: PlanQuote = {
  kind: "ok", cash: 5000, borrowAsset: "USDC", asset: "ETH", collateral: 2.5, collateralUsd: 7500, price: 3000, liqPrice: 1800, dropPct: 40, adding: false,
  apr: 3.4, yearly: 170, feesLine: "One-time network fee: about $4 to set up the loan.", lender: "Aave v3", network: "Base",
};
const base = (over: Partial<PlanBlockProps> = {}): PlanBlockProps => ({
  block: { kind: "plan", cash: 5000 }, maxCash: 10000, cashText: "$5,000", safetyIdx: 1, onCashText: () => {}, onSafety: () => {}, onSend: () => {}, quote: ok, ...over,
});

describe("PlanBlock", () => {
  it("prints the quote figures", () => {
    const onSend = vi.fn();
    render(<PlanBlock {...base({ onSend })} />);
    expect(screen.getByText("You get $5,000 as USDC, a digital dollar.")).toBeTruthy();
    expect(screen.getByText("You lock 2.50 ETH ($7,500).")).toBeTruthy();
    expect(screen.getByText("The lender could sell some of your ETH if its price falls to about $1,800 (40% below today's $3,000).")).toBeTruthy();
    expect(screen.getByText("About $170 a year at 3.4%. The rate can change.")).toBeTruthy();
    expect(screen.getByText("One-time network fee: about $4 to set up the loan.")).toBeTruthy();
    expect(screen.getByText("On Base, with Aave v3.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    expect(onSend).toHaveBeenCalled();
  });
  it("shows move steps and the cheaper alternative", () => {
    const onUseAlt = vi.fn();
    render(<PlanBlock {...base({ onUseAlt, quote: { ...ok, move: { line: "Move 2.50 ETH from Base to Ethereum (about 10 minutes).", reason: "Moving saves." }, alt: { line: "Spark costs less.", venueId: "spark", venueName: "Spark" } } })} />);
    expect(screen.getByRole("button", { name: "Approve move in your wallet (step 1 of 2)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use Spark" }));
    expect(onUseAlt).toHaveBeenCalledWith("spark");
  });
  it("shows loading and error states", () => {
    const { rerender } = render(<PlanBlock {...base({ loading: true, quote: null })} />);
    expect(screen.getByText("Working out the plan")).toBeTruthy();
    rerender(<PlanBlock {...base({ error: "Could not reach the lender.", quote: null })} />);
    expect(screen.getByRole("alert").textContent).toBe("Could not reach the lender.");
  });
  it("shows not-feasible and unavailable states", () => {
    const { rerender } = render(<PlanBlock {...base({ quote: { kind: "notFeasible", asset: "ETH", cash: 5000 } })} />);
    expect(screen.getByText("Your ETH can't safely back $5,000 right now. Try a smaller amount or another safety level.")).toBeTruthy();
    rerender(<PlanBlock {...base({ quote: { kind: "notFeasible", asset: "ETH", cash: 5000, reason: "The lender is full." } })} />);
    expect(screen.getByText("The lender is full.")).toBeTruthy();
    rerender(<PlanBlock {...base({ quote: { kind: "unavailable" } })} />);
    expect(screen.getByText("Loans are not available for this Safe yet.")).toBeTruthy();
  });
  it("validates the amount", () => {
    render(<PlanBlock {...base({ cashText: "$5", quote: null })} />);
    expect(screen.getByText("The smallest loan is $10.")).toBeTruthy();
  });
  it("notes a capped request", () => {
    render(<PlanBlock {...base({ block: { kind: "plan", cash: 20000 }, cashText: "$10,000" })} />);
    expect(screen.getByText("Capped at $10,000, the most this Safe can borrow.")).toBeTruthy();
  });
  it("freezes earlier plans, shows receipts, and explains an empty Safe", () => {
    const { rerender } = render(<PlanBlock {...base({ live: false })} />);
    expect(screen.getByText("Earlier plan for $5,000")).toBeTruthy();
    rerender(<PlanBlock {...base({ sent: "Sent to your Safe: borrow $5,000 from Aave v3, locking 2.50 ETH." })} />);
    expect(screen.getByText("Sent to your Safe: borrow $5,000 from Aave v3, locking 2.50 ETH.")).toBeTruthy();
    rerender(<PlanBlock {...base({ maxCash: 5, networkName: "Base" })} />);
    expect(screen.getByText("This Safe doesn't hold enough ETH or wstETH on Base to borrow $10 safely.")).toBeTruthy();
  });
  it("a refused plan is a refusal card from the start, with what is missing and no editor", () => {
    render(<PlanBlock {...base({ block: { kind: "plan", cash: 20, refusal: { reason: "not_enough_collateral", needUsd: 120 } }, networkName: "Base" })} />);
    expect(screen.getByText(/to borrow \$20 safely\. You'd need about \$120 more\./)).toBeTruthy();
    expect(screen.queryByLabelText("Cash you need")).toBeNull();
  });
  it("shows the footer between the figures and the send button, and nothing extra without it", () => {
    const { container, rerender } = render(<PlanBlock {...base({ footer: <p>Checked: this would work. Network fee about $0.02.</p> })} />);
    const line = screen.getByText("Checked: this would work. Network fee about $0.02.");
    const button = screen.getByRole("button", { name: "Approve in your wallet" });
    expect(line.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("On Base, with Aave v3.").compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(<PlanBlock {...base()} />);
    const list = container.querySelector("ul")!;
    expect(list.nextElementSibling).toBe(screen.getByRole("button", { name: "Approve in your wallet" }));
  });
  it("says what the selected safety option means, linked to the group", () => {
    const { rerender, container } = render(<PlanBlock {...base({ safetyIdx: 1 })} />);
    const balanced = "Balanced: the middle choice between how much ETH you lock and how far its price can fall.";
    const hint = screen.getByText(balanced);
    expect(container.querySelector("fieldset")!.getAttribute("aria-describedby")).toBe(hint.id);
    rerender(<PlanBlock {...base({ safetyIdx: 0 })} />);
    expect(screen.getByText("Extra safe: you lock more ETH, so its price can fall further before the lender can sell it to repay the loan.")).toBeTruthy();
    expect(screen.queryByText(balanced)).toBeNull();
    rerender(<PlanBlock {...base({ safetyIdx: 2, cashText: "$50", quote: null })} />);
    expect(screen.getByText("Lean: you lock less ETH, so a smaller price fall lets the lender sell it to repay the loan.")).toBeTruthy();
  });
  it("asks to add the agent instead of sending when it is not a proposer", () => {
    render(<PlanBlock {...base({ addAgentNetwork: "Base", addAgentSlot: <button>Add agent to this Safe</button> })} />);
    expect(screen.getByText("Add the agent to this Safe on Base so I can send proposals.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve in your wallet" })).toBeNull();
  });
});
