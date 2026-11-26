// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProposalCard } from "./ProposalCard";
import type { ProposalView } from "@/server/proposals/view";

afterEach(cleanup);
const HASH = `0x${"ab".repeat(32)}` as const;
const base: ProposalView = {
  id: "p1", chainId: 8453, title: "Protect Aave loan", steps: ["Allow Aave", "Supply 1 ETH"], outcome: "Uses 1 ETH.", stage: "queued", segments: ["current", "todo", "todo"], countLabel: "0 of 2 signed",
  sentence: "In your Safe queue. Needs 2 signatures.", needsSignatures: 2, signedCount: 0, links: { tx: "https://app.safe.global/tx", queue: "https://app.safe.global/queue" },
  inSafe: true, noncePassed: false, safeTxHash: HASH, hashMismatch: false, nonce: "3", viewerSigned: false, final: false, createdAt: "2026-01-01T00:00:00.000Z", specKind: "protect", calls: [],
};

describe("ProposalCard", () => {
  it("shows the stored text, the sentence and the short hash", () => {
    render(<ProposalCard proposal={base} />);
    expect(screen.getByText("Protect Aave loan")).toBeTruthy();
    expect(screen.getByText("Uses 1 ETH.")).toBeTruthy();
    expect(screen.getByText("Supply 1 ETH")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("In your Safe queue. Needs 2 signatures.");
    expect(screen.getByTitle(HASH).textContent).toBe("0xabababab…ababab");
    expect(screen.getByRole("link", { name: "Open Safe to sign" }).getAttribute("href")).toBe("https://app.safe.global/tx");
  });
  it("states a close's signing deadline", () => {
    render(<ProposalCard proposal={{ ...base, signBy: "2026-01-08T12:00:00.000Z" }} />);
    expect(screen.getByText("Sign by Jan 8, 2026")).toBeTruthy();
  });
  it("falls back to the queue link", () => {
    render(<ProposalCard proposal={{ ...base, links: { ...base.links, tx: null } }} />);
    expect(screen.getByRole("link", { name: "Open Safe to sign" }).getAttribute("href")).toBe("https://app.safe.global/queue");
  });
  it("has no sign, approve or reject buttons without actions", () => {
    render(<ProposalCard proposal={base} />);
    expect(screen.queryByRole("button", { name: /sign|approve|reject|send/i })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Copy the code to match in Safe"]);
  });
  it("renders the actions slot and a stopped card with Open in Safe", () => {
    render(<ProposalCard proposal={{ ...base, stage: "rejected", sentence: "Rejected here. It is still in your Safe queue. Reject it in Safe too." }} actions={<button>Mine</button>} />);
    expect(screen.getByText(/Reject it in Safe too/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mine" })).toBeTruthy();
    expect(screen.queryByText("Uses 1 ETH.")).toBeNull();
  });
  it("warns when the stored hash differs", () => {
    render(<ProposalCard proposal={{ ...base, hashMismatch: true }} />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  it("shows the next step and a link styled as a button, never a signing button", () => {
    render(<ProposalCard proposal={{ ...base, nextStep: "Your signature is needed. Open Safe, check that the code below matches, then sign." }} />);
    expect(screen.getByText(/Your signature is needed/)).toBeTruthy();
    const a = screen.getByRole("link", { name: "Open Safe to sign" });
    expect(a.getAttribute("href")).toBe("https://app.safe.global/tx");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("Opens Safe{Wallet} in a new tab.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign|approve/i })).toBeNull();
    expect(screen.getByText("Match this code in Safe")).toBeTruthy();
  });
  it("offers Open Safe to execute when all signatures are in", () => {
    render(<ProposalCard proposal={{ ...base, needsSignatures: 0, signedCount: 2 }} />);
    expect(screen.getByRole("link", { name: "Open Safe to execute" })).toBeTruthy();
  });
  it("keeps the plain link once the viewer signed, and on a hash mismatch", () => {
    const { unmount } = render(<ProposalCard proposal={{ ...base, viewerSigned: true }} />);
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
    unmount();
    render(<ProposalCard proposal={{ ...base, hashMismatch: true }} />);
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Safe to sign" })).toBeNull();
  });
  it("hides the code when nothing reached the Safe queue", () => {
    render(<ProposalCard proposal={{ ...base, stage: "rejected", inSafe: false, sentence: "Rejected. Nothing was sent." }} />);
    expect(screen.queryByText("Match this code in Safe")).toBeNull();
  });
  it("shows the code and its explainer in one framed box while it can be signed", () => {
    render(<ProposalCard proposal={base} />);
    const box = screen.getByText("Match this code in Safe").closest("div")!;
    expect(box.textContent).toMatch(/Copy/);
    expect(box.textContent).toMatch(/find “Safe transaction hash”/);
    expect(box.textContent).toMatch(/reject it here/);
  });
  it("shows no Match this code row on a failed or executed card", () => {
    const { unmount } = render(<ProposalCard proposal={{ ...base, stage: "failed", inSafe: false }} />);
    expect(screen.queryByText("Match this code in Safe")).toBeNull();
    unmount();
    render(<ProposalCard proposal={{ ...base, stage: "executed", needsSignatures: 0 }} />);
    expect(screen.queryByText("Match this code in Safe")).toBeNull();
  });
  it("still shows the code on a rejected proposal that is open in Safe", () => {
    render(<ProposalCard proposal={{ ...base, stage: "rejected", inSafe: true }} />);
    expect(screen.getByText("Match this code in Safe")).toBeTruthy();
  });
  it("shows the count next to the bar", () => {
    render(<ProposalCard proposal={base} />);
    expect(screen.getByText("0 of 2 signed")).toBeTruthy();
  });
  it("an executed card says what happened and offers View loan or Go to overview", () => {
    const done = { ...base, stage: "executed" as const, needsSignatures: 0, sentence: "Done. Executed in Safe.", doneLine: "Done. $1,000 USDC is now in your Safe.", loanId: "L1" };
    const { unmount } = render(<ProposalCard proposal={done} loanHref="/s/0xabc/loans/L1" loanLabel="View loan" />);
    expect(screen.getByRole("status").textContent).toBe("Done. $1,000 USDC is now in your Safe.");
    expect(screen.getByRole("link", { name: "View loan" }).getAttribute("href")).toBe("/s/0xabc/loans/L1");
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
    unmount();
    render(<ProposalCard proposal={done} loanHref="/s/0xabc" loanLabel="Go to overview" />);
    expect(screen.getByRole("link", { name: "Go to overview" })).toBeTruthy();
  });
  it("hides the title when asked (the page header has it)", () => {
    render(<ProposalCard proposal={base} hideTitle />);
    expect(screen.queryByText("Protect Aave loan")).toBeNull();
  });
  it("shows the safety level in the details, and nothing for older proposals", () => {
    const { unmount } = render(<ProposalCard proposal={{ ...base, safety: "Lean" }} />);
    expect(screen.getByText("Safety: Lean")).toBeTruthy();
    unmount();
    const { unmount: unmount2 } = render(<ProposalCard proposal={base} />);
    expect(screen.queryByText(/Safety:/)).toBeNull();
    unmount2();
    render(<ProposalCard proposal={{ ...base, safety: "" as never }} />);
    expect(screen.queryByText(/Safety/)).toBeNull();
  });
});
