// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { riskBanner } from "@/lib/loan-copy";
import { D10_NOTE } from "@/server/fixes/copy";
import type { FixDraftView, FixOptions } from "@/client/fixes";
import { FixCard } from "./FixCard";
import { RiskBanner } from "./RiskBanner";

afterEach(cleanup);

const opt = (k: "coll" | "repay" | "both", over: object = {}) => ({ k, label: `label ${k}`, addColl: 1, repay: 1000, hf: 1.7, sub: "About $3,000 from your Safe", short: false, recommended: false, ...over });
const options = (os: ReturnType<typeof opt>[]): FixOptions => ({ loanId: "l", chainId: 8453, lender: "Aave v3", collAsset: "ETH", healthFactor: 1.04, levels: { warn: 1.6, act: 1.35 }, atRisk: true, urgent: true, options: os, note: "", blockNumber: 1 });
const draft = (over: Partial<FixDraftView> = {}): FixDraftView => ({
  id: "d1", loanId: "l", chainId: 8453, option: "coll", title: "Protect Aave v3 loan", steps: ["Wrap ETH", "Lock 1.00 ETH in Aave v3"], healthBefore: 1.04, healthAfter: 1.62,
  testRunLine: "Checked: this would work. Network fee about $0.02.", canSend: true, urgent: true, urgentNote: D10_NOTE, stillNeeds: "Drafted, not yet sent to Safe. It still needs 2 signatures in Safe.",
  state: "draft", proposalId: null, spec: { kind: "protect", loanId: "l", addColl: 1, repay: 0 }, ...over,
});
const base = { sigs: 2, agentOn: true, onPick: () => {}, onSend: () => {}, state: { fix: "none" as const, replaced: [] } };

describe("FixCard", () => {
  it("greys a short option, keeps the 'Needs' line, and marks Recommended only with two usable options", () => {
    const onPick = vi.fn();
    render(<FixCard {...base} onPick={onPick} draft={null} options={options([opt("coll", { recommended: true }), opt("both"), opt("repay", { short: true, sub: "Needs 4,000 USDC. Your Safe has 0 USDC." })])} />);
    expect(screen.getByText("Needs 4,000 USDC. Your Safe has 0 USDC.")).toBeTruthy();
    expect((screen.getByText("label repay").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(screen.getAllByText(/needs 2 signatures/)).toHaveLength(2);
    fireEvent.click(screen.getByText("label coll"));
    expect(onPick).toHaveBeenCalledWith("coll");
  });

  it("a draft shows steps, health before and after, the test run, and that it still needs a signature", () => {
    render(<FixCard {...base} options={null} draft={draft()} />);
    expect(screen.getByText("Lock 1.00 ETH in Aave v3")).toBeTruthy();
    expect(screen.getByText("1.04 → 1.62")).toBeTruthy();
    expect(screen.getByText(/Checked: this would work/)).toBeTruthy();
    expect(screen.getByText(/still needs 2 signatures/)).toBeTruthy();
  });

  it("an urgent draft carries the D-10 note and never says the other transaction is cancelled", () => {
    render(<FixCard {...base} options={null} draft={draft()} />);
    const note = screen.getByTestId("urgent-note").textContent!;
    expect(note).toBe(D10_NOTE);
    expect(note).toMatch(/Signing this fix does not cancel the other/);
    expect(note).toMatch(/deleting a proposal does not take back signatures already given/);
  });

  it("a draft that is not urgent has no note; Send is disabled when the test run did not pass", () => {
    const onSend = vi.fn();
    render(<FixCard {...base} onSend={onSend} options={null} draft={draft({ urgent: false, urgentNote: null, canSend: false })} />);
    expect(screen.queryByTestId("urgent-note")).toBeNull();
    expect((screen.getByRole("button", { name: "Send to Safe" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the draft by its id; a sent fix links to Safe", () => {
    const onSend = vi.fn();
    const { rerender } = render(<FixCard {...base} onSend={onSend} options={null} draft={draft()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Safe" }));
    expect(onSend).toHaveBeenCalledWith("d1");
    rerender(<FixCard {...base} options={null} draft={draft({ state: "sent" })} safeLink="https://app.safe.global/x" />);
    expect(screen.getByRole("link", { name: "Open in Safe" }).getAttribute("href")).toBe("https://app.safe.global/x");
    expect(screen.queryByRole("button", { name: "Send to Safe" })).toBeNull();
  });

  it("after a second price fall the old card reads Replaced and the options come back", () => {
    render(<FixCard {...base} state={{ fix: "none", replaced: [{ id: "old" }] }} draft={null} options={options([opt("coll")])} />);
    expect(screen.getByText(/earlier fix was replaced/i)).toBeTruthy();
  });
});

describe("RiskBanner (BP-23)", () => {
  it("reads the mockup's line, with 'A fix is waiting for signatures in your Safe.' once queued", () => {
    render(<RiskBanner hf={1.1} fix="queued" safeLink="https://app.safe.global/x" />);
    expect(screen.getByRole("alert").textContent).toContain(riskBanner(1.1, "queued"));
    expect(screen.getByRole("alert").textContent).toMatch(/A fix is waiting for signatures in your Safe\./);
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
  });
  it("a loan with a drafted fix says so; one with none says add collateral or repay", () => {
    const { rerender } = render(<RiskBanner hf={1.1} fix="draft" />);
    expect(screen.getByRole("alert").textContent).toMatch(/A fix is drafted below\. Send it to Safe, then sign\./);
    rerender(<RiskBanner hf={1.1} fix="none" />);
    expect(screen.getByRole("alert").textContent).toMatch(/Add collateral or repay\./);
  });

  it("VC-03: after a draft exactly one option is pressed, Choose another is shown, and the conflict note sits in a closed details", () => {
    render(<FixCard {...base} options={options([opt("coll"), opt("repay")])} draft={draft()} />);
    const pressed = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toContain("label coll");
    expect(screen.getByRole("button", { name: "Choose another" })).toBeTruthy();
    const note = screen.getByTestId("urgent-note");
    const details = note.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText("Another proposal is already waiting")).toBeTruthy();
  });

  it("VC-03: Choose another moves focus to the first option without drafting", () => {
    const onPick = vi.fn();
    render(<FixCard {...base} onPick={onPick} options={options([opt("coll"), opt("repay")])} draft={draft()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
    expect(document.activeElement?.textContent).toContain("label coll");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("VC-03: embedded has no red wrapper of its own", () => {
    render(<FixCard {...base} embedded options={options([opt("coll")])} draft={null} />);
    expect(screen.getByTestId("fix-options").className).not.toContain("bg-destructive/10");
  });
});
