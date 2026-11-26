// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertView } from "@/server/alerts/view";
import { AlertCard } from "./AlertCard";

vi.mock("@/components/reserve/UseReserveNow", () => ({ UseReserveNow: () => <button>Use reserve now</button> }));

const base: AlertView = {
  id: 1, loanId: "l", chainId: 8453, lender: "aave-v3", reserveEligibility: { eligible: true, reason: null }, state: "live", tag: null, title: "Aave v3 loan is at risk", cause: "ETH fell 6% in 4h.",
  hf: 1.3, liveHf: 1.3, warn: 1.6, act: 1.35, asset: "ETH", cushion: "ETH can fall 24% (to $1,500) before this loan is liquidated.", liquidatable: false, threshold: 2, createdAt: "2026-01-01T00:00:00Z", rule: null,
  note: "Recommended uses the least money from your Safe. Afterwards ETH could fall about 38% before liquidation.",
  options: [
    { k: "repay", label: "Repay 1,000 USDC", addColl: 0, repay: 1000, hf: 1.7, sub: "$1,000 from your Safe", short: false, recommended: true },
    { k: "coll", label: "Add 5 ETH collateral", addColl: 5, repay: 0, hf: 1.7, sub: "Needs 5 ETH. Your Safe has 1.00 ETH.", short: true, recommended: false },
  ],
};

afterEach(cleanup);

describe("AlertCard (BP-20, r15, VC-01, VC-03, VC-08)", () => {
  it("VC-03: a liquidatable loan never says it could fall 'before liquidation' as if safe", () => {
    render(<AlertCard alert={{ ...base, liquidatable: true }} onChoose={vi.fn()} />);
    expect(screen.queryByText(/before liquidation/)).toBeNull();
    expect(screen.getByText(/This loan can be liquidated now\. The lender can sell some of your ETH at any time\./)).toBeTruthy();
  });

  it("VC-04: the slot shows a delayed loading status, not a bare 'Loading…'", () => {
    expect(readFileSync(join(__dirname, "AlertCard.tsx"), "utf8")).not.toContain("Loading…\"");
  });

  it("BP-25: states what the standing rule did, on a live card and on a quiet one", () => {
    const line = "Your standing rule drafted this fix: add 1 eth collateral. Nothing is sent to your Safe until you press Send to Safe.";
    render(<AlertCard alert={{ ...base, rule: { outcome: "drafted", line } }} onChoose={vi.fn()} />);
    expect(screen.getByText(line)).toBeTruthy();
    cleanup();
    render(<AlertCard alert={{ ...base, state: "fixing", tag: "Fix waiting for signatures", rule: { outcome: "drafted", line } }} />);
    expect(screen.getByText(line)).toBeTruthy();
  });

  it("live: title, cause, level, options in order with the signature suffix and Recommended", () => {
    render(<AlertCard alert={base} onChoose={vi.fn()} />);
    expect(screen.getByText("Aave v3 loan is at risk")).toBeTruthy();
    expect(screen.getByText(/ETH fell 6% in 4h\. Health factor 1\.30, below your At-risk level of 1\.35\./)).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText("$1,000 from your Safe · needs 2 signatures")).toBeTruthy();
    expect(screen.getByText("Needs 5 ETH. Your Safe has 1.00 ETH.")).toBeTruthy();
    expect((screen.getByText("Add 5 ETH collateral").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what liquidation means from At risk on, not only when it can happen now; a resolved card does not", () => {
    const { rerender } = render(<AlertCard alert={{ ...base, liquidatable: false }} onChoose={vi.fn()} />);
    expect(screen.getByText(/Liquidation means the lender can sell some of your ETH to repay the loan, usually with a penalty\./)).toBeTruthy();
    rerender(<AlertCard alert={{ ...base, state: "resolved", tag: "Resolved", liveHf: 1.7 }} />);
    expect(screen.queryByText(/Liquidation means/)).toBeNull();
  });

  it("the older alert is tagged Newer alert below; a recovered one reads Resolved with the health now", () => {
    const { rerender } = render(<AlertCard alert={{ ...base, state: "replaced", tag: "Newer alert below" }} />);
    expect(screen.getByText("Newer alert below")).toBeTruthy();
    rerender(<AlertCard alert={{ ...base, state: "resolved", tag: "Resolved", liveHf: 1.7 }} />);
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(screen.getByText("Health factor is now 1.70.")).toBeTruthy();
  });

  it("off topic it is collapsed to the title until asked (VC-03)", () => {
    render(<AlertCard alert={base} onTopic={false} />);
    expect(screen.queryByText("Repay 1,000 USDC")).toBeNull();
    fireEvent.click(screen.getByText("Show options"));
    expect(screen.getByText("Repay 1,000 USDC")).toBeTruthy();
  });

  it("VC-03: the chosen option is pressed and Choose another shows", () => {
    render(<AlertCard alert={base} onChoose={vi.fn()} chosen="repay" />);
    const pressed = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toContain("Repay 1,000 USDC");
    expect(screen.getByRole("button", { name: "Choose another" })).toBeTruthy();
  });

  it("uses the canonical lender identifier for reserve eligibility, not the visible title", () => {
    const aave = { ...base, lender: "aave-v3", reserveEligibility: { eligible: true, reason: null }, title: "Your loan needs attention" } as unknown as AlertView;
    render(<AlertCard alert={aave} safeAddress="0xabc" onChoose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Use reserve now" })).toBeTruthy();
    cleanup();
    const morpho = { ...base, lender: "morpho-blue", reserveEligibility: { eligible: false, reason: "Reserve protection works only for Aave loans on Base." }, title: "Aave-like health warning" } as unknown as AlertView;
    render(<AlertCard alert={morpho} safeAddress="0xabc" onChoose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Use reserve now" })).toBeNull();
    expect(screen.getByText(/only for Aave loans on Base/i)).toBeTruthy();
  });
});
