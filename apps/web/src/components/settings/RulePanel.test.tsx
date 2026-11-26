// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RulePanelLoan } from "@/server/rules";
import { RulePanel } from "./RulePanel";

afterEach(cleanup);
const off: RulePanelLoan = { loanId: "8453:0xabc:aave-v3", lender: "Aave v3", asset: "ETH", rule: null, note: "Off. When Aave v3 drops below its At-risk level, the agent alerts you and suggests a fix." };
const on: RulePanelLoan = { ...off, rule: { option: "repay", enabled: true }, note: "On. When Aave v3 drops below its At-risk level, the agent drafts a repayment. Nothing is sent to your Safe until you press Send to Safe, and you still sign in Safe." };

describe("RulePanel (BP-25)", () => {
  it("shows the note that says what the rule does", () => {
    render(<RulePanel loans={[on]} onSave={async () => {}} onDelete={async () => {}} />);
    expect(screen.getByText(/^On\. .*Send to Safe.*you still sign in Safe\./)).toBeTruthy();
  });

  it("choosing a fix saves it on, the switch turns it off, delete removes it", async () => {
    const onSave = vi.fn(async () => {});
    const onDelete = vi.fn(async () => {});
    const { rerender } = render(<RulePanel loans={[off]} onSave={onSave} onDelete={onDelete} />);
    fireEvent.change(screen.getByLabelText("Aave v3 rule"), { target: { value: "coll" } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(off.loanId, "coll", true));
    rerender(<RulePanel loans={[on]} onSave={onSave} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText("Aave v3 rule on"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(on.loanId, "repay", false));
    fireEvent.click(screen.getByText("Delete rule"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(on.loanId));
  });

  it("a refusal is shown and says it was not saved", async () => {
    render(<RulePanel loans={[off]} onSave={async () => { throw new Error("Not allowed"); }} onDelete={async () => {}} />);
    fireEvent.change(screen.getByLabelText("Aave v3 rule"), { target: { value: "coll" } });
    expect(await screen.findByText("Not allowed Not saved.")).toBeTruthy();
  });
});
