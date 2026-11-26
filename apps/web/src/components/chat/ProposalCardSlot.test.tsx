// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProposalView } from "@/server/proposals/view";
import { useShowOnScreen } from "@/components/proposals/on-screen";
import { ProposalCardSlot, type ProposalCardSlotProps } from "./ProposalCardSlot";

const view = (over: Partial<ProposalView> = {}): ProposalView => ({
  id: "p1", chainId: 8453, title: "Open a $2,000 Aave v3 loan", steps: ["Borrow 2,000 USDC"], outcome: "On Base.", stage: "queued",
  segments: ["current", "todo", "todo"], sentence: "In your Safe queue. Needs 2 signatures.", needsSignatures: 2, signedCount: 0,
  links: { tx: "https://app.safe.global/tx", queue: "https://app.safe.global/queue" }, inSafe: true, safeTxHash: null, hashMismatch: false,
  nonce: "0", viewerSigned: false, final: false, createdAt: "2026-01-01T00:00:00.000Z", ...over,
} as ProposalView);

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const renderSlot = (props: Partial<ProposalCardSlotProps> = {}) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProposalCardSlot safeAddress="0xabc" proposalId="p1" {...props} /></QueryClientProvider>);

describe("ProposalCardSlot placement (VC-07)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const hash = `0x${"ab".repeat(32)}` as const;
  const owners = (a: boolean, b: boolean) => [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: a, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: b, isYou: false }] as ProposalView["owners"];

  it("a queued plan whose nonce was passed says it is being checked, with no action and no approval count", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ safeTxHash: hash, state: "settling", owners: owners(false, false), threshold: 2, canSign: false, canSend: false }) }));
    renderSlot();
    expect(await screen.findByText(/Checking whether this ran/)).toBeTruthy();
    expect(screen.getByText(/We are checking whether this transaction was the one that ran/)).toBeTruthy();
    expect(screen.queryByText(/Out of date|Nothing was sent|0 of 2 approved/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Review/ })).toBeNull();
  });
  it("an unresolved Safe submission shows the server instruction and direct queue link without an approval count", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ stage: "sending", state: null, sentence: "Safe submission outcome is being checked. Review your Safe queue; do not send this transaction again.", signedCount: 0, threshold: undefined }) }));
    renderSlot({ placement: "thread" });
    expect(await screen.findByText(/submission outcome is being checked/)).toBeTruthy();
    expect(screen.queryByText(/0 of .* approved/)).toBeNull();
    expect(screen.getByRole("link", { name: "Check Safe queue" }).getAttribute("href")).toBe("https://app.safe.global/queue");
    expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
  });

  it("the dock shows a stub, not the card, while the page shows the same proposal", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ safeTxHash: hash }) }));
    const page = renderHook(() => useShowOnScreen("p1"));
    renderSlot({ placement: "dock" });
    expect(await screen.findByText(/Shown on this page/)).toBeTruthy();
    page.unmount();
    expect(await screen.findByRole("link", { name: "Review" })).toBeTruthy();
  });
  it("the thread shows the short summary card: one button to the page, no signing and no Safe{Wallet} sign link", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ safeTxHash: hash, owners: owners(false, false), threshold: 2, state: "needs_your_signature", canSign: true, facts: { sentence: "x", changes: [], terms: [], numbers: [{ value: "2,000 USDC", label: "You get" }, { value: "1.24 ETH", label: "You lock" }, { value: "$68/yr", label: "Interest" }] } }) }));
    renderSlot({ placement: "sheet" });
    const go = await screen.findByRole("link", { name: "Review and approve" });
    expect(go.getAttribute("href")).toBe("/s/0xabc/proposals/p1");
    expect(screen.getByText("0 of 2 approved")).toBeTruthy();
    expect(screen.getByText("2,000 USDC")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open Safe to sign/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve in your wallet|^Reject/ })).toBeNull();
  });
  it("waiting: the card's button copies the link in place", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ safeTxHash: hash, signedCount: 1, needsSignatures: 1, owners: owners(true, false), threshold: 2, state: "waiting_for_others", viewerSigned: true }) }));
    renderSlot();
    fireEvent.click(await screen.findByRole("button", { name: "Copy link for your co-owner" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://localhost:3000/s/0xabc/proposals/p1"));
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
  });
  it("a replaced proposal in a thread is one stub that names the replacement and links to it", async () => {
    vi.mocked(fetch).mockImplementation((u) => json({ proposal: String(u).endsWith("/p2") ? view({ id: "p2", title: "Open a $2,000 Morpho loan" }) : view({ stage: "replaced", replacedBy: "p2", title: "Open a $800 Morpho loan", inSafe: false, final: true }) }));
    renderSlot();
    expect(await screen.findByText("Replaced by the $2,000 plan")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
    expect(screen.getByRole("link", { name: "View" }).getAttribute("href")).toBe("/s/0xabc/proposals/p2");
  });
  it.each(["stale", "rejected", "stopped", "not_sent", "failed"] as const)("a %s proposal in a thread is a stub", async (stage) => {
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ stage, inSafe: false, final: true }) }));
    renderSlot({ placement: "dock" });
    const stub = await screen.findByRole("link", { name: "View" });
    expect(stub.getAttribute("href")).toBe("/s/0xabc/proposals/p1");
  });
  it("an executed plan collapses to a Done stub with a way to the loan", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ stage: "executed", final: true }) }));
    renderSlot();
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to overview" })).toBeTruthy();
  });
  it("an executed plan's stub names the proceeds in the Safe and links the proposal's own loan", async () => {
    vi.mocked(fetch).mockImplementation((u) => String(u).includes("/loans") ? json({ loans: [{ id: "8453:0xabc:morpho" }, { id: "newer-loan" }] }) : json({ proposal: view({ stage: "executed", final: true, loanId: "8453:0xabc:morpho", doneLine: "Done. $2,000 USDC is now in your Safe." }) }));
    renderSlot();
    expect(await screen.findByText(/now in your Safe/)).toBeTruthy();
    const loan = screen.getByRole("link", { name: "View loan" });
    expect(loan.getAttribute("href")).toContain("8453%3A0xabc%3Amorpho");
    expect(loan.getAttribute("href")).not.toContain("newer-loan");
  });
  it("an executed plan's stub links the execution transaction", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ proposal: view({ stage: "executed", final: true, executionTxHash: `0x${"cd".repeat(32)}` }) }));
    renderSlot();
    await screen.findByText(/^Done/);
    expect(document.querySelector('a[href*="/tx/0xcdcd"]')).toBeTruthy();
  });
  it("a card that was open becomes the Done stub when the window regains focus after the Safe ran it", async () => {
    let stage: "queued" | "executed" = "queued";
    vi.mocked(fetch).mockImplementation((u) => String(u).includes("/loans") ? json({ loans: [{ id: "L1" }] }) : json({ proposal: view(stage === "queued" ? {} : { stage: "executed", final: true, loanId: "L1" }) }));
    renderSlot();
    expect(await screen.findByRole("link", { name: "Review" })).toBeTruthy();
    stage = "executed";
    window.dispatchEvent(new Event("visibilitychange"));
    expect((await screen.findByText("Done")).parentElement?.textContent).toContain("Done · Loan open");
    expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
  });
});

describe("ProposalCardSlot unknown proposal (VC-04)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it("a 404 says it could not find the proposal, without claiming nothing changed, with a way back", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ error: "not found" }, 404));
    renderSlot();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/We could not find this proposal/);
    // Not found cannot vouch that nothing changed (loan-09): the plan may have run or been removed.
    expect(alert.textContent).not.toMatch(/Nothing on your Safe has changed/);
    expect(screen.getByRole("link", { name: "Back to Overview" }).getAttribute("href")).toBe("/s/0xabc");
  });
  it("a server error offers Try again", async () => {
    vi.mocked(fetch).mockImplementation(() => json({ error: "x" }, 500));
    renderSlot();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
