// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProposalView } from "@/server/proposals/view";
import type { ReviewCtx } from "./review-state";
import { feeFromReceipt } from "./review-state";
import { ReviewView, type ReviewHandlers } from "./ProposalReview";

afterEach(cleanup);
const YOU = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CO = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const HASH = `0xd3ff${"ab".repeat(30)}` as `0x${string}`;
const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";

const facts = {
  sentence: "You'll borrow 2,000 USDC from Morpho and lock 1.24 ETH as collateral.",
  changes: [{ label: "You receive", hint: "USDC, a dollar-priced coin", amount: "+2,000 USDC", tone: "in" as const }, { label: "You lock up", amount: "−1.24 ETH", tone: "out" as const }],
  terms: [{ label: "Lender", value: "Morpho" }, { label: "Network", value: "Base" }, { label: "Interest per year", value: "3.4% · about $68", hint: "can change" }, { label: "Liquidation price", value: "$1,874 per ETH" }],
  healthLine: "The lender could sell some of this collateral if its price falls below the liquidation price shown above.",
};
const base = (o: Partial<ProposalView> = {}): ProposalView => ({
  id: "p1", chainId: 8453, title: "Open a $2,000 loan", steps: ["Lock 1.24 ETH", "Borrow 2,000 USDC"], outcome: "On Base.", stage: "queued", segments: [], sentence: "", needsSignatures: 2, signedCount: 0,
  links: { tx: "https://app.safe.global/tx", queue: "https://app.safe.global/queue" }, inSafe: true, safeTxHash: HASH, hashMismatch: false, nonce: "7", viewerSigned: false, final: false,
  createdAt: "2026-11-16T14:25:00.000Z", specKind: "open", owners: [{ address: YOU, signed: false, isYou: true }, { address: CO, signed: false, isYou: false }], threshold: 2,
  state: "needs_your_signature", canSign: true, canSend: false, facts, ...o,
} as ProposalView);

const handlers = (): ReviewHandlers => ({ onSign: vi.fn(), onApproveSend: vi.fn(), onSend: vi.fn(), onCopy: vi.fn(), onSwitch: vi.fn(), onCheckAgain: vi.fn(), onTryAgain: vi.fn() });
const ctx0: ReviewCtx = { phase: "idle", lastSignerSends: true, safe: "0x5afE…0001", next: { text: "Make a new plan", href: "/plan" } };
const show = (p: ProposalView, ctx: Partial<ReviewCtx> = {}, extra: Record<string, unknown> = {}) => {
  const h = handlers();
  render(<ReviewView p={p} ctx={{ ...ctx0, ...ctx }} safeAddress={SAFE} handlers={h} rejectSlot={<button type="button">Reject this plan</button>} activityHref="/a" loanHref="/loan" {...extra} />);
  return h;
};
const bar = () => within(document.querySelector("[data-slot=action-bar]") as HTMLElement);
const BANNED = /\b(signature|execute|nonce|hash|queue|Health factor)\b/i;

const states: [string, ProposalView, Partial<ReviewCtx>, { id: string; headline: string; primary: string | null; reject: boolean }][] = [
  ["needs", base(), {}, { id: "needs_your_signature", headline: "Your approval is needed", primary: "Approve in your wallet", reject: true }],
  ["last signer sends", base({ signedCount: 1, canSend: true, owners: [{ address: YOU, signed: false, isYou: true }, { address: CO, signed: true, isYou: false }] }), { fee: "about $0.02" }, { id: "needs_last_send", headline: "Your co-owner approved. Now it's you", primary: "Approve and send", reject: true }],
  ["last signer, flag off", base({ signedCount: 1, canSend: true, owners: [{ address: YOU, signed: false, isYou: true }, { address: CO, signed: true, isYou: false }] }), { lastSignerSends: false }, { id: "needs_last", headline: "Your co-owner approved. Now it's you", primary: "Approve in your wallet", reject: true }],
  ["smart account", base(), { smartAccount: true, fee: "about $0.02" }, { id: "smart_account", headline: "Your approval is needed", primary: "Approve (about $0.02)", reject: true }],
  ["wallet open", base(), { phase: "walletOpen" }, { id: "wallet_open", headline: "Confirm in your wallet", primary: "Waiting for your wallet…", reject: false }],
  ["wallet closed", base(), { phase: "walletClosed" }, { id: "wallet_closed", headline: "You closed the wallet request", primary: "Approve in your wallet", reject: true }],
  ["saving", base(), { phase: "saving" }, { id: "saving", headline: "Got it. Saving your approval…", primary: "Saving…", reject: false }],
  ["waiting", base({ state: "waiting_for_others", viewerSigned: true, signedCount: 1, owners: [{ address: YOU, signed: true, isYou: true }, { address: CO, signed: false, isYou: false }] }), {}, { id: "waiting_for_others", headline: "Waiting for your co-owner", primary: "Copy link for your co-owner", reject: true }],
  ["ready", base({ state: "ready_to_send", canSend: true, signedCount: 2 }), { fee: "about $0.02" }, { id: "ready_to_send", headline: "Both approved. Ready to send", primary: "Send transaction", reject: false }],
  ["no fee ETH", base({ state: "ready_to_send", canSend: true, signedCount: 2 }), { noFeeEth: true }, { id: "no_fee_eth", headline: "Both approved. Ready to send", primary: "Copy link for another owner", reject: false }],
  ["would fail", base({ state: "ready_to_send", canSend: true, signedCount: 2 }), { wouldFail: "Morpho refused the loan: ETH's price moved" }, { id: "would_fail", headline: "Sending would fail right now", primary: "Check again", reject: false }],
  ["sending", base({ state: "sending", pendingTxHash: HASH }), {}, { id: "sending", headline: "Sending to Base…", primary: "Sending…", reject: false }],
  ["executed", base({ stage: "executed", state: "executed", owners: undefined, doneLine: "Done. $2,000 USDC is now in your Safe.", final: true }), { loanListed: true }, { id: "executed", headline: "Your loan is open", primary: "View loan", reject: false }],
  ["failed", base({ stage: "failed", state: "failed", owners: undefined, failedReason: "It reverted.", final: true }), {}, { id: "failed", headline: "It didn't go through", primary: "Make a new plan", reject: false }],
  ["blocked", base({ state: "blocked", blockedBy: [{ id: "p0", nonce: "6", title: "Send 150 USDC" }] }), {}, { id: "blocked", headline: "An earlier transaction has to go first", primary: "Open the earlier transaction", reject: true }],
  ["out of date", base({ stage: "stale", state: "out_of_date", owners: undefined, inSafe: false, final: true }), {}, { id: "out_of_date", headline: "This plan is out of date", primary: "Make a new plan", reject: false }],
  ["settling", base({ state: "settling", canSign: false, canSend: false }), {}, { id: "settling", headline: "Checking whether this ran", primary: null, reject: false }],
  ["replaced", base({ stage: "replaced", state: "rejected", replacedBy: "p2", owners: undefined, final: true }), {}, { id: "replaced", headline: "You made a newer plan", primary: "See the new plan", reject: false }],
  ["rejected", base({ stage: "rejected", state: "rejected", owners: undefined, inSafe: false, final: true }), {}, { id: "rejected", headline: "This plan was rejected", primary: "Make a new plan", reject: false }],
  ["hash mismatch", base({ hashMismatch: true }), {}, { id: "hash_mismatch", headline: "This plan doesn't match what's stored", primary: "Make a new plan", reject: false }],
  ["wrong wallet", base(), { wrongWallet: true }, { id: "wrong_wallet", headline: "This needs a different wallet", primary: "Switch wallet", reject: false }],
];

describe("ReviewView states (spec table)", () => {
  it.each(states)("%s: exact headline, one primary, Reject only where allowed, banned words stay in Technical details", (_n, p, ctx, want) => {
    show(p, ctx);
    expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe(want.id);
    expect(bar().getByRole("heading", { name: want.headline })).toBeTruthy();
    if (want.primary) {
      const prim = Array.from(document.querySelectorAll("[data-slot=action-bar] button, [data-slot=action-bar] a")).filter((e) => e.textContent?.startsWith(want.primary!));
      expect(prim.length).toBeGreaterThan(0);
    }
    // exactly one high-emphasis control: the "default" variant button/link, or a disabled status button
    const high = Array.from(document.querySelectorAll("[data-slot=action-bar] [data-slot=button]")).filter((e) => !e.className.includes("border-edge") || e.className.includes("bg-primary"));
    expect(high.length).toBeLessThanOrEqual(1);
    expect(!!screen.queryByRole("button", { name: "Reject this plan" })).toBe(want.reject);
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("details").forEach((d) => d.remove());
    const outside = (copy.textContent ?? "").replace(want.id === "rejected" ? /Safe's queue/g : /$^/, "");
    expect(outside).not.toMatch(BANNED);
    expect(document.body.textContent).not.toContain("Open Safe to sign");
  });
  it("the count appears once per region (F12)", () => {
    show(base());
    expect(screen.getAllByText(/0 of 2 approved/)).toHaveLength(1);
  });
  it("hash mismatch has no Approve or Send", () => {
    show(base({ hashMismatch: true }));
    expect(screen.queryByRole("button", { name: /Approve|Send transaction/ })).toBeNull();
  });
  it("the roster says You and Co-owner and shows Saving… while saving", () => {
    show(base(), { phase: "saving" });
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Co-owner")).toBeTruthy();
    expect(screen.getByText("Saving…", { selector: "span" })).toBeTruthy();
  });
  it("sections: sentence, changes, terms, health; Technical details holds the full hashes", () => {
    show(base(), {}, { signData: { domainHash: `0x${"11".repeat(32)}`, messageHash: `0x${"22".repeat(32)}` } });
    expect(screen.queryByText(/You'll borrow 2,000 USDC from Morpho/)).toBeNull(); // the rows say it
    expect(screen.getByText("+2,000 USDC")).toBeTruthy();
    expect(screen.getByText("Liquidation price")).toBeTruthy();
    expect(screen.getByText(/Loan health after/)).toBeTruthy();
    const tech = screen.getByText("Technical details").closest("details")!;
    expect(tech.textContent).not.toContain(HASH); // a signer sees the hash on the page, not behind a click
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(tech.textContent).toContain("11".repeat(32));
    expect(tech.textContent).toContain("22".repeat(32));
    expect(tech.textContent).toContain(SAFE);
  });
  it("with no balance rows the sentence is still shown", () => {
    const b = base();
    show({ ...b, facts: { ...b.facts!, changes: [] } });
    expect(screen.getByText(/You'll borrow 2,000 USDC from Morpho/)).toBeTruthy();
  });
  it("clicks go to the handlers", () => {
    const h = show(base());
    fireEvent.click(bar().getByRole("button", { name: "Approve in your wallet" }));
    expect(h.onSign).toHaveBeenCalled();
  });
  it("Approve and send is one step; Only approve is the free alternative", () => {
    const h = show(base({ signedCount: 1, canSend: true }));
    fireEvent.click(bar().getByRole("button", { name: "Approve and send" }));
    expect(h.onApproveSend).toHaveBeenCalled();
    fireEvent.click(bar().getByRole("button", { name: "Only approve (free)" }));
    expect(h.onSign).toHaveBeenCalled();
  });
  it("waiting: copy link is the primary and shows Link copied", () => {
    const h = show(base({ state: "waiting_for_others", viewerSigned: true }), {}, { copied: true });
    expect(bar().getByRole("button", { name: "Link copied" })).toBeTruthy();
    expect(h.onCopy).not.toHaveBeenCalled();
  });
  it("phones with share offer Share link with", () => {
    show(base({ state: "waiting_for_others", viewerSigned: true }), {}, { shareable: true });
    expect(bar().getByRole("button", { name: "Share link with your co-owner" })).toBeTruthy();
  });
  it("an error from the wallet or server shows as an alert in the bar", () => {
    show(base(), {}, { error: "Your wallet is on a different network." });
    expect(bar().getByRole("alert").textContent).toContain("different network");
  });
  it("Reject is labelled Reject, and the page is a single column no wider than 640px", () => {
    show(base());
    expect(screen.getByRole("button", { name: "Reject this plan" })).toBeTruthy();
    expect(document.querySelector("[data-state]")!.className).toContain("max-w-[640px]");
  });
});

describe("sign-flow fix1: copy and sending", () => {
  const last = () => base({ signedCount: 1, canSend: true, owners: [{ address: YOU, signed: false, isYou: true }, { address: CO, signed: true, isYou: false }] });
  it("last signer with an unknown fee never says 'a network fee of a small network fee'", () => {
    show(last());
    expect(document.body.textContent).not.toMatch(/fee of a small|Network fee a small/);
    expect(document.body.textContent).toContain("a small network fee");
  });
  it("a stale proposal still in Safe must be checked or rejected before another plan", () => {
    const p = base({ stage: "stale", state: "out_of_date", inSafe: true, noncePassed: false, final: false, signedCount: 1 });
    show(p);
    expect(document.body.textContent).toMatch(/still in your Safe queue|may still be sent/i);
    expect(bar().queryByRole("link", { name: /Make a new plan|Plan again/ })).toBeNull();
    expect(bar().getByRole("link", { name: /Reject in Safe/ })).toBeTruthy();
  });
  it("a stale proposal with an expired Safe nonce can be replaced even while its queue row remains", () => {
    const p = base({ stage: "stale", state: "out_of_date", inSafe: true, noncePassed: true, final: false, signedCount: 1 });
    show(p);
    expect(bar().getByRole("link", { name: "Make a new plan" })).toBeTruthy();
    expect(bar().queryByRole("link", { name: /Reject in Safe/ })).toBeNull();
    expect(document.body.textContent).toMatch(/Safe has moved past this plan|can no longer run/i);
  });
  it("a stale proposal with an unreadable nonce keeps the Safe rejection safeguard", () => {
    const p = base({ stage: "stale", state: "out_of_date", inSafe: true, noncePassed: null, final: false, signedCount: 1 });
    show(p);
    expect(bar().queryByRole("link", { name: /Make a new plan/ })).toBeNull();
    expect(bar().getByRole("link", { name: /Reject in Safe/ })).toBeTruthy();
    expect(document.body.textContent).toMatch(/couldn't check whether your Safe has moved past this plan/i);
  });
  it("a stale proposal no longer in Safe can be replaced", () => {
    const p = base({ stage: "stale", state: "out_of_date", inSafe: false, final: true });
    show(p);
    expect(bar().getByRole("link", { name: "Make a new plan" })).toBeTruthy();
  });
  it("last signer with a known fee uses it", () => {
    show(last(), { fee: "about $0.02" });
    expect(document.body.textContent).toContain("Network fee to run it: about $0.02 (paid by whoever presses Send)");
  });
  it("executed names the locked ETH, the fee paid and the sender", () => {
    show(base({ stage: "executed", state: "executed", owners: undefined, doneLine: "Done. $2,000 USDC is now in your Safe.", final: true }), { loanListed: true, sender: "you", feePaid: "$0.02" });
    const t = bar().getByRole("note").textContent ?? "";
    expect(document.body.textContent).toContain("You borrowed 2,000 USDC from Morpho and locked 1.24 ETH.");
    expect(t).toContain("Network fee paid: $0.02, by you.");
  });
  it("failed gives the reason, the fee, and offers Try sending again when retryable", () => {
    const p = base({ stage: "failed", state: "failed", owners: undefined, failedReason: "Morpho refused the loan: ETH's price moved.", final: true });
    show(p, { retryable: true, sender: "you", feePaid: "$0.02" });
    expect(bar().getByRole("button", { name: "Try sending again" })).toBeTruthy();
    expect(document.body.textContent).toContain("Morpho refused the loan: ETH's price moved. Nothing in your Safe changed.");
    expect(document.body.textContent).toContain("The network fee of $0.02 was still paid by you.");
  });
  it("waiting keeps 'You approved at'", () => {
    show(base({ state: "waiting_for_others", viewerSigned: true }), { approvedAt: "2:31 pm" });
    expect(document.body.textContent).toContain("You approved at 2:31 pm.");
  });
  it("sending: a local send shows Sending, never Ready or out of date, with the tx link", () => {
    for (const state of ["ready_to_send", "out_of_date"] as const) {
      cleanup();
      show(base({ state, canSend: true, signedCount: 2 }), { sending: true, txUrl: "https://basescan.org/tx/0x1" });
      expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe("sending");
      expect(bar().getByRole("button", { name: "Sending…" })).toBeTruthy();
      expect(bar().getByRole("link", { name: /View transaction/ }).getAttribute("href")).toBe("https://basescan.org/tx/0x1");
    }
  });
  it("a pending server hash also suppresses out of date", () => {
    show(base({ state: "out_of_date", stage: "stale", pendingTxHash: HASH }));
    expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe("sending");
  });
  it("an unresolved Safe submission sends the owner to the Safe queue without an approval count", () => {
    show(base({ stage: "sending", state: null, sentence: "Safe submission outcome is being checked. Review your Safe queue; do not send this transaction again.", signedCount: 0, threshold: undefined }));
    expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe("sending_unknown");
    expect(screen.getByRole("link", { name: "Check Safe queue" }).getAttribute("href")).toBe("https://app.safe.global/queue");
    expect(document.body.textContent).toContain("do not send this transaction again");
    expect(screen.queryByText(/0 of .* approved/)).toBeNull();
  });
  it("a sent plan that is executed shows executed even if sending is still set", () => {
    show(base({ stage: "executed", state: "executed", owners: undefined, final: true }), { sending: true });
    expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe("executed");
  });
});

describe("review fixes", () => {
  it("a replaced plan that already has approvals says it can still be sent, with the Safe link and the new plan", () => {
    show(base({ stage: "replaced", state: "rejected", replacedBy: "p2", signedCount: 1, owners: undefined, final: true }));
    expect(document.body.textContent).toContain("This older plan already has approvals and can still be sent from Safe{Wallet}. Only one of the two can go through. Reject it in Safe{Wallet} if you don't want it.");
    expect(bar().getByRole("link", { name: /Check in Safe/ }).getAttribute("href")).toBe("https://app.safe.global/tx");
    expect(bar().getByRole("link", { name: "See the new plan" }).getAttribute("href")).toBe("./p2");
  });
  it("a replaced plan without approvals keeps the plain note", () => {
    show(base({ stage: "replaced", state: "rejected", replacedBy: "p2", signedCount: 0, owners: undefined, final: true }));
    expect(document.body.textContent).not.toContain("can still be sent");
    expect(screen.queryByRole("link", { name: /Check in Safe/ })).toBeNull();
  });
  it("the fee from a receipt is gasUsed x effectiveGasPrice in ETH and dollars", () => {
    expect(feeFromReceipt({ gasUsed: 200_000n, effectiveGasPrice: 100_000_000n }, 3000)).toBe("0.00002 ETH ($0.06)");
    expect(feeFromReceipt({ gasUsed: 200_000n, effectiveGasPrice: 100_000_000n })).toBe("0.00002 ETH");
  });
  it("an estimate is never labelled paid; a paid figure is", () => {
    const ex = base({ stage: "executed", state: "executed", owners: undefined, final: true });
    show(ex, { sender: "you", feeEstimate: "about $0.02" });
    expect(document.body.textContent).toContain("Network fee: about $0.02.");
    expect(document.body.textContent).not.toMatch(/fee paid|paid by/i);
    cleanup();
    show(ex, { sender: "you", feePaid: "0.00002 ETH ($0.06)" });
    expect(document.body.textContent).toContain("Network fee paid: 0.00002 ETH ($0.06), by you.");
    cleanup();
    show(ex, { sender: "the sender" });
    expect(document.body.textContent).not.toMatch(/Network fee/);
  });

  it("shows the Safe with explorer, copy and Safe app links before signing (proposals-02)", () => {
    show(base());
    const head = screen.getByTestId("safe-identity");
    expect(head.textContent).toContain("0x5afE…0001");
    expect(head.textContent).toContain("Base");
    expect(within(head).getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect((within(head).getByRole("link", { name: /View on/ }) as HTMLAnchorElement).href).toBe(`https://basescan.org/address/${SAFE}`);
    expect(within(head).getByRole("link", { name: "Open in Safe" })).toBeTruthy();
  });
  it("labels the approval chain from the transaction even when the plan text differs", () => {
    show(base({ chainId: 84532 }));
    const head = screen.getByTestId("safe-identity");
    expect(within(head).getByText("Base Sepolia")).toBeTruthy();
    expect(within(head).queryByText("Base", { exact: true })).toBeNull();
    expect(head.querySelector('img[src="/network-marks/base.svg"]')).toBeTruthy();
    expect(head.textContent).toContain("Base Sepolia");
  });
  it("shows the full hash with copy for a signer, and not for a viewer who cannot sign (proposals-03)", () => {
    show(base());
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Safe transaction hash" })).toBeTruthy();
    cleanup();
    show(base({ canSign: false, state: "waiting_for_others", viewerSigned: true }));
    expect(screen.getByText("Technical details").closest("details")!.textContent).toContain(HASH);
  });
  const TX = `0x${"cd".repeat(32)}` as `0x${string}`;
  const done = (o: Partial<ProposalView> = {}) => base({ stage: "executed", state: "executed", owners: undefined, final: true, executionTxHash: TX, executedAt: "2026-11-16T14:31:00.000Z", approvals: [{ address: YOU, at: "2026-11-16T14:27:00.000Z", isYou: true }, { address: CO, at: "2026-11-16T14:29:00.000Z", isYou: false }], ...o });
  it("an executed proposal links the execution transaction on the explorer for any viewer, and View receipt goes there (proposals-01)", () => {
    show(done(), { loanListed: true });
    expect(screen.getByTitle(TX)).toBeTruthy();
    const receipt = screen.getByRole("link", { name: /View receipt/ }) as HTMLAnchorElement;
    expect(receipt.href).toBe(`https://basescan.org/tx/${TX}`);
    const safe = screen.getByRole("link", { name: /Check in Safe/ }) as HTMLAnchorElement;
    expect(safe.href).toBe("https://app.safe.global/tx");
  });
  it("without a stored hash View receipt is not offered as a duplicate of the Safe link", () => {
    show(done({ executionTxHash: undefined }), { loanListed: true });
    expect(screen.queryByRole("link", { name: /View receipt/ })).toBeNull();
  });
  it("keeps an 'Approved by' roster after the run (proposals-04)", () => {
    show(done());
    const r = screen.getByTestId("approved-by");
    expect(r.textContent).toContain("Approved by");
    expect(r.textContent).toContain("You");
    expect(r.textContent).toContain("0x3C44…93BC");
  });
  it("shows the target contract with an address component (proposals-07)", () => {
    show(base({ target: "0x1111111111111111111111111111111111111111" }));
    expect(screen.getByText("Steps in this transaction").closest("details")!.textContent).toContain("0x1111…1111");
  });
  it("lists the contracts the transaction calls, warning on unknown ones (proposals-07)", () => {
    const calls = [
      { to: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", name: "Morpho", value: "0", selector: "0x12345678", fn: "supplyCollateral", delegate: false },
      { to: "0x3333333333333333333333333333333333333333", name: null, value: "1000000000000000000", selector: null, fn: null, delegate: false },
    ] as ProposalView["calls"];
    show(base({ calls }));
    const list = within(screen.getByTestId("calls"));
    expect(list.getByText("Contracts this calls")).toBeTruthy();
    expect(list.getByText("Morpho")).toBeTruthy();
    expect(list.getByText("0xBBBB…FFCb")).toBeTruthy();
    expect(list.getByText(/Calls supplyCollateral/)).toBeTruthy();
    expect(list.getByText("Unknown contract")).toBeTruthy();
    expect(list.getByText(/Sends 1 ETH/)).toBeTruthy();
  });
  it("warns when a call runs as the Safe (delegatecall)", () => {
    const calls = [{ to: "0x3333333333333333333333333333333333333333", name: "WETH", value: "0", selector: null, fn: null, delegate: true }] as ProposalView["calls"];
    show(base({ calls }));
    expect(within(screen.getByTestId("calls")).getByText(/Runs as your Safe \(delegatecall\)/)).toBeTruthy();
  });
  it("shows the outer MultiSendCallOnly delegatecall, then the inner calls", () => {
    const calls = [
      { to: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2", name: "MultiSendCallOnly", value: "0", selector: "0x8d80ff0a", fn: "multiSend", delegate: true, outer: true },
      { to: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", name: "Morpho", value: "0", selector: "0x12345678", fn: "supplyCollateral", delegate: false },
    ] as ProposalView["calls"];
    show(base({ calls }));
    const list = within(screen.getByTestId("calls"));
    expect(list.getByText("MultiSendCallOnly")).toBeTruthy();
    expect(list.getByText(/Delegatecall, runs as your Safe/)).toBeTruthy();
    expect(list.getByText("Morpho")).toBeTruthy();
    expect(list.queryByText(/Could not read the batch contents/)).toBeNull();
  });
  it("warns strongly on a delegatecall to another contract and when the batch cannot be read", () => {
    const unknown = [{ to: "0x3333333333333333333333333333333333333333", name: null, value: "0", selector: null, fn: null, delegate: true, outer: true }] as ProposalView["calls"];
    show(base({ calls: unknown }));
    expect(within(screen.getByTestId("calls")).getByText("Unknown contract")).toBeTruthy();
    expect(within(screen.getByTestId("calls")).getByText(/Runs as your Safe \(delegatecall\)/)).toBeTruthy();
    cleanup();
    const unreadable = [{ to: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2", name: "MultiSendCallOnly", value: "0", selector: null, fn: null, delegate: true, outer: true, unreadable: true }] as ProposalView["calls"];
    show(base({ calls: unreadable }));
    expect(within(screen.getByTestId("calls")).getByText(/Could not read the batch contents/)).toBeTruthy();
  });
  it("shows the safety level when the proposal has one (proposals-safety)", () => {
    show(base({ safety: "Balanced" }));
    expect(document.body.textContent).toContain("Safety: Balanced");
    cleanup();
    show(base());
    expect(document.body.textContent).not.toContain("Safety:");
  });
  it("shows exactly one fee sentence per state (proposals-06)", () => {
    const count = () => (document.body.textContent?.match(/network fee/gi) ?? []).length;
    show(base({ state: "ready_to_send", canSend: true, signedCount: 2 }), { fee: "about $0.02" });
    expect(document.body.textContent).toContain("Network fee to run it: about $0.02 (paid by whoever presses Send)");
    expect(count()).toBe(1);
    cleanup();
    show(base({ stage: "executed", state: "executed", owners: undefined, final: true }), { feePaid: "$0.03" });
    expect(count()).toBe(1);
  });
  it("never renders an empty Safety label", () => {
    show(base({ safety: undefined }));
    expect(document.body.textContent).not.toContain("Safety");
    cleanup();
    show(base({ safety: "" as never }));
    expect(document.body.textContent).not.toContain("Safety");
  });
  it("the plain needs-approval headline does not repeat the approvals caption (proposals-09)", () => {
    show(base());
    expect(bar().queryByText(/Nothing moves until/)).toBeNull();
  });
});

describe("1-of-1 Safe", () => {
  const solo = (o: Partial<ProposalView> = {}) => base({ threshold: 1, needsSignatures: 1, canSend: true, owners: [{ address: YOU, signed: false, isYou: true }], ...o });
  it("offers one Approve and send, with no co-owner wording", () => {
    const h = show(solo(), { fee: "about $0.02" });
    expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe("needs_last_send");
    fireEvent.click(bar().getByRole("button", { name: "Approve and send" }));
    expect(h.onApproveSend).toHaveBeenCalled();
    expect(bar().queryByRole("button", { name: "Approve in your wallet" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/both owners|both of you|co-owner/i);
    expect(document.body.textContent).toContain("1 of 1 approved".replace("1 of", "0 of"));
    expect(screen.getAllByText("You").length).toBe(1);
  });
  it("without last-signer-sends it is a plain approve, still without co-owner wording", () => {
    show(solo(), { lastSignerSends: false });
    expect(bar().getByRole("button", { name: "Approve in your wallet" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/both owners|both of you|co-owner/i);
  });
});

describe("executed (done) state", () => {
  const done = () => base({ stage: "executed", state: "executed", owners: undefined, final: true, doneLine: "Done. $2,000 USDC is now in your Safe." });
  it("is past tense, says completion and the liquidation price once, and leads with View loan", () => {
    show(done(), { loanListed: true, sender: "you", feePaid: "$0.02" });
    const text = document.body.textContent ?? "";
    expect(text).toContain("You borrowed 2,000 USDC from Morpho and locked 1.24 ETH");
    expect(text).not.toContain("You'll borrow");
    expect(text).not.toMatch(/Loan health after/);
    expect(text.match(/\$1,874/g)?.length).toBe(1);
    expect(text).toContain("2,000 USDC is now in your Safe");
    expect(text.match(/Your loan is open/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(bar().getByRole("link", { name: "View loan" })).toBeTruthy();
  });

  it("an executed open loan links directly to this funded Safe, but repay and failed proposals do not", () => {
    show(done(), { loanListed: true });
    const funded = screen.getByRole("link", { name: "Open my funded Safe" }) as HTMLAnchorElement;
    expect(funded.href).toBe(`https://app.safe.global/home?safe=base:${SAFE}`);
    expect(funded.target).toBe("_blank");
    expect(funded.rel).toContain("noreferrer");
    expect(bar().getByRole("link", { name: "View loan" })).toBeTruthy();

    cleanup();
    show({ ...done(), specKind: "repay" }, { loanListed: true });
    expect(screen.queryByRole("link", { name: "Open my funded Safe" })).toBeNull();

    cleanup();
    show(base({ stage: "failed", state: "failed", specKind: "open", owners: undefined, final: true }));
    expect(screen.queryByRole("link", { name: "Open my funded Safe" })).toBeNull();
  });
});

describe("last signer: approve-and-send precheck", () => {
  const last = () => base({ signedCount: 1, canSend: true, owners: [{ address: YOU, signed: false, isYou: true }, { address: CO, signed: true, isYou: false }] });
  it("a failed send precheck surfaces the reason, recovery and the free approval — not another approve-and-send", () => {
    const h = show(last(), { wouldFail: "Morpho refused the loan: ETH's price moved" });
    expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe("approve_send_failed");
    const note = bar().getByRole("note");
    expect(note.textContent).toContain("ETH's price moved");
    expect(note.textContent).toContain("Nothing was approved or sent");
    expect(bar().queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(bar().getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(bar().queryByRole("link", { name: "Make a new plan" })).toBeNull();
    fireEvent.click(bar().getByRole("button", { name: "Check again" }));
    expect(h.onCheckAgain).toHaveBeenCalled();
    fireEvent.click(bar().getByRole("button", { name: "Only approve (free)" }));
    expect(h.onSign).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reject this plan" })).toBeTruthy();
  });
  it("when the last signer has no fee ETH, approve freely first; do not say the co-owner can send yet", () => {
    show(last(), { noFeeEth: true, fee: "about $0.02" });
    expect(document.querySelector("[data-state]")!.getAttribute("data-state")).toBe("needs_last_no_fee");
    expect(bar().queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(bar().getByRole("button", { name: "Approve in your wallet" })).toBeTruthy();
    expect(document.body.textContent).toContain("$0.02");
    expect(document.body.textContent).toMatch(/approve.*first/i);
    expect(document.body.textContent).not.toMatch(/co-owner can send/i);
    expect(document.body.textContent).toContain("approving is free");
  });
  it("a sole owner with no fee ETH gets a useful recovery without an imaginary co-owner", () => {
    show(base({ threshold: 1, signedCount: 0, needsSignatures: 1, canSend: true, owners: [{ address: YOU, signed: false, isYou: true }] }), { noFeeEth: true });
    expect(document.body.textContent).toMatch(/approve.*first/i);
    expect(document.body.textContent).not.toMatch(/co-owner/i);
  });
  it("a failed precheck offers a fresh check instead of a generic new-loan plan", () => {
    show(base({ specKind: "close", state: "ready_to_send", canSend: true, signedCount: 2 }), { wouldFail: "The close would fail" });
    expect(bar().getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(bar().queryByRole("link", { name: /Make a new plan/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Prices moved/);
  });
  it("a threshold-one owner can reject when its send precheck cannot be completed", () => {
    const one = base({ threshold: 1, signedCount: 0, needsSignatures: 1, canSend: true, canSign: true, owners: [{ address: YOU, signed: false, isYou: true }] });
    show(one, { precheckReady: false, precheckError: "The nonce could not be checked." });
    expect(bar().getByRole("button", { name: "Only approve (free)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject this plan" })).toBeTruthy();
  });
  it("a failed loan action returns to its loan instead of opening the Get cash planner", () => {
    show(base({ stage: "failed", state: "failed", specKind: "close", final: true }), { next: { text: "Back to the loan", href: "/s/example/loans/L1" } });
    expect(bar().getByRole("link", { name: "Back to the loan" }).getAttribute("href")).toBe("/s/example/loans/L1");
    expect(bar().queryByRole("link", { name: "Make a new plan" })).toBeNull();
  });
  it("a denied clipboard never says Link copied and shows the link to select", () => {
    show(base({ state: "waiting_for_others", viewerSigned: true }), {}, { manualLink: "https://app.example/s/0x/proposals/p1" });
    expect(bar().queryByRole("button", { name: "Link copied" })).toBeNull();
    expect(screen.getByDisplayValue("https://app.example/s/0x/proposals/p1")).toBeTruthy();
  });
});

it("explains that the lender may sell collateral without promising advance warning", () => {
  show(base());
  expect(document.body.textContent).toContain("Loan health after: The lender could sell some of this collateral");
  expect(document.body.textContent).not.toMatch(/stays safe unless|will alert you before/i);
});

describe("threshold 1 wording", () => {
  const O3 = "0x3333333333333333333333333333333333333333" as const;
  const one = [{ address: YOU as `0x${string}`, signed: false, isYou: true }];
  const three = [...one, { address: CO as `0x${string}`, signed: false, isYou: false }, { address: O3, signed: false, isYou: false }];
  it("1-of-1 says you're the only owner", () => {
    show(base({ threshold: 1, owners: one }));
    expect(screen.getAllByText(/only owner/).length).toBeGreaterThan(0);
  });
  it("1-of-3 says your approval is enough, never the only owner, and lists every owner", () => {
    show(base({ threshold: 1, owners: three }), {});
    expect(screen.queryByText(/only owner/)).toBeNull();
    expect(screen.getAllByText(/Your approval is enough/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/any one owner can approve and send/i).length).toBeGreaterThan(0);
  });
});
