// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OUT_OF_DATE_LINE } from "@/server/moves/expiry";
import type { MoveView } from "@/server/moves/service";
import { MoveCard, SEND_MOVE_LABEL } from "./MoveCard";

afterEach(cleanup);
const move: MoveView = {
  id: "m1", status: "quoted", title: "Move 4.86 ETH to Ethereum", moveLine: "Move 4.86 ETH from Base to Ethereum (about 10 minutes).",
  reason: "No lender on Base can lend $7,500 against your ETH at this safety level. Compound v3 on Ethereum can, so your ETH moves there first.",
  feesLine: "One-time network fee for the move: about $4. The loan's fee is shown with the loan, in step 2.",
  outcome: "Step 1 of 2. Moves 4.86 ETH from Base to Ethereum, about 10 minutes. You still hold it: it goes to your Safe's address on Ethereum. When it arrives I draft the loan, step 2, for you to sign.",
  steps: ["Allow 4.86 ETH to leave Base", "Send 4.86 ETH from Base to Ethereum"], expiresAt: "2026-11-14T10:15:00Z", outOfDate: false, sentence: "Drafted, not yet sent to Safe.", canSend: true, proposalId: null, replacedBy: null,
};

describe("MoveCard", () => {
  it("shows the move line, the reason, one fees line, the steps and 'You still hold it'", () => {
    const onSend = vi.fn();
    render(<MoveCard move={move} onSend={onSend} />);
    expect(screen.getByText(move.moveLine)).toBeTruthy();
    expect(screen.getByText(move.moveLine).textContent).not.toMatch(/\$/); // the move line carries no fee (OC-01)
    expect(screen.getByText(move.reason!)).toBeTruthy();
    expect(screen.getAllByText(/network fee/i)).toHaveLength(1);
    expect(screen.getByText(/You still hold it/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: SEND_MOVE_LABEL }));
    expect(onSend).toHaveBeenCalledOnce();
  });
  it("reads 'Out of date' with no Send button once the quote ran out", () => {
    render(<MoveCard move={{ ...move, outOfDate: true, canSend: false, status: "expired", sentence: OUT_OF_DATE_LINE }} />);
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(OUT_OF_DATE_LINE);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/You still hold it/)).toBeNull();
  });
  it("has no Send button once it is in the queue", () => {
    render(<MoveCard move={{ ...move, status: "queued", canSend: false, sentence: "In your Safe queue. Sign it there, then the move starts." }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
