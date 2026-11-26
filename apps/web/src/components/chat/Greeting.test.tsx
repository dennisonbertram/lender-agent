// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Greeting } from "./Greeting";

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Greeting", () => {
  it("shows the text, the time, and chips that send", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [] })
      : Response.json({ text: "Hi. You can borrow up to $5,000.", chips: ["Borrow $5,000", "How does this work?"], max: 5000, blockNumber: 7, readAt: Date.UTC(2026, 0, 1, 12, 0) })));
    const onSend = vi.fn();
    wrap(<Greeting safeAddress="0xabc" onSend={onSend} />);
    expect(await screen.findByText(/You can borrow up to \$5,000/)).toBeTruthy();
    expect(screen.getByText(/^as of \d\d:\d\d$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Borrow $5,000" }));
    expect(onSend).toHaveBeenCalledWith("Borrow $5,000");
    fireEvent.click(screen.getByRole("button", { name: "How does this work?" }));
    expect(onSend).toHaveBeenCalledWith("How does this work?");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/safes/0xabc/blocks/greeting"));
  });
  it("keeps a Get Cash dock greeting to contextual help instead of a competing offer", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [] })
      : Response.json({ text: "You can borrow up to $3,225.", why: "Why $3,225? Based on collateral.", chips: ["Borrow $3,225", "Why this limit?", "How does this work?", "Add funds"], max: 3225, blockNumber: 7, readAt: 1 })));
    const onSend = vi.fn();
    wrap(<Greeting safeAddress="0xabc" onSend={onSend} contextualHelpOnly />);

    const help = await screen.findByRole("button", { name: "How does this work?" });
    expect(screen.queryByText(/borrow up to \$3,225/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Why/ })).toBeNull();
    expect(screen.queryByText(/^as of /)).toBeNull();
    expect(screen.queryByRole("button", { name: "Borrow $3,225" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Why this limit?" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add funds" })).toBeNull();
    fireEvent.click(help);
    expect(onSend).toHaveBeenCalledWith("How does this work?");
  });
  it("says balances are unknown when the greeting read fails instead of telling the borrower to add funds", async () => {
    const fetchMock = vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [{ id: "p9", title: "Open a $1,000 Morpho loan", stage: "queued", state: "needs_your_signature", canSign: true, canSend: false, signedCount: 1, threshold: 2, owners: [{ signed: true }, { signed: false, isYou: true }] }] })
      : new Response(JSON.stringify({ error: "Network read failed." }), { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    wrap(<Greeting safeAddress="0xabc" onSend={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/I couldn't check your Safe's balances/);
    expect(screen.queryByRole("button", { name: "Add funds" })).toBeNull();
    expect(screen.getByRole("link", { name: "Review and approve" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/safes/0xabc/blocks/greeting")).toHaveLength(2));
  });
  it("a co-signer with a plan waiting sees a Review card instead of the borrow chips", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [{ id: "p9", title: "Open a $1,000 Morpho loan", stage: "queued", state: "needs_your_signature", canSign: true, canSend: false, signedCount: 1, threshold: 2, owners: [{ signed: true }, { signed: false, isYou: true }] }] })
      : Response.json({ text: "Hi.", chips: ["Borrow $5,000"], max: 5000, blockNumber: 7, readAt: 1 })));
    wrap(<Greeting safeAddress="0xabc" onSend={vi.fn()} />);
    expect(await screen.findByText("Your co-owner approved. Now it's you")).toBeTruthy();
    expect(screen.getByText(/1 of 2 approved/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review and approve" }).getAttribute("href")).toBe("/s/0xabc/proposals/p9");
    expect(screen.queryByText(/waiting for your approval/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Borrow $5,000" })).toBeNull();
  });
  it("shows ready to send when both owners have approved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [{ id: "p9", title: "Open a $1,000 Morpho loan", stage: "queued", state: "ready_to_send", canSign: false, canSend: true, signedCount: 2, threshold: 2, owners: [{ signed: true }, { signed: true }] }] })
      : Response.json({ text: "Hi.", chips: [], max: 5000, blockNumber: 7, readAt: 1 })));
    wrap(<Greeting safeAddress="0xabc" onSend={vi.fn()} />);
    expect(await screen.findByText("Both approved. Ready to send")).toBeTruthy();
    expect(screen.getByText("2 of 2 approved")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review and send" })).toBeTruthy();
  });
  it("keeps the urgent loan repair as the one chat action when the viewer cannot act on a pending proposal", async () => {
    const onSend = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [{ id: "waiting", title: "Open a loan", stage: "queued", state: "waiting_for_others", canSign: false, canSend: false, viewerSigned: true, signedCount: 1, threshold: 2, owners: [{ signed: true, isYou: true }, { signed: false }] }] })
      : Response.json({ text: "One of your loans needs attention first.", chips: ["Fix my Aave v3 loan", "How does this work?"], max: 5000, blockNumber: 7, readAt: 1 })));
    wrap(<Greeting safeAddress="0xabc" onSend={onSend} contextualHelpOnly />);
    expect(await screen.findByText("Waiting for your co-owner")).toBeTruthy();
    const fix = screen.getByRole("button", { name: "Fix my Aave v3 loan" });
    expect(fix).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Copy link for your co-owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "How does this work?" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Borrow $5,000" })).toBeNull();
    fireEvent.click(fix);
    expect(onSend).toHaveBeenCalledWith("Fix my Aave v3 loan");
  });
  it("shows a sending proposal in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [{ id: "p9", title: "Open a $1,000 Morpho loan", stage: "queued", state: "sending", pendingTxHash: `0x${"ab".repeat(32)}`, canSign: false, canSend: false, signedCount: 2, threshold: 2, owners: [{ signed: true }, { signed: true }], links: { tx: null, queue: "https://app.safe.global/queue" } }] })
      : Response.json({ text: "Hi.", chips: [], max: 5000, blockNumber: 7, readAt: 1 })));
    wrap(<Greeting safeAddress="0xabc" onSend={vi.fn()} />);
    expect(await screen.findByText("Sending to Base…")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sending…" })).toBeTruthy();
  });
  it("prioritizes an older proposal this owner can sign over a newer blocked proposal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [
          { id: "newer", title: "Open another loan", stage: "queued", state: "blocked", canSign: false, signedCount: 0, threshold: 2, owners: [{ signed: false, isYou: true }, { signed: false }], links: { tx: null, queue: "https://app.safe.global/queue" } },
          { id: "needs-me", title: "Open the earlier loan", stage: "queued", state: "needs_your_signature", canSign: true, signedCount: 1, threshold: 2, owners: [{ signed: true }, { signed: false, isYou: true }], links: { tx: null, queue: "https://app.safe.global/queue" } },
        ] })
      : Response.json({ text: "Hi.", chips: [], max: 5000, blockNumber: 7, readAt: 1 })));
    wrap(<Greeting safeAddress="0xabc" onSend={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "Review and approve" });
    expect(link.getAttribute("href")).toBe("/s/0xabc/proposals/needs-me");
  });
  it("prioritizes an older ready-to-send proposal over a newer nonce-blocked proposal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [
          { id: "newer-blocked", title: "Newer proposal", stage: "queued", state: "blocked", canSign: true, canSend: false, signedCount: 0, threshold: 2, blockedBy: [{ id: "older", nonce: "3", title: "Earlier proposal" }], owners: [{ signed: false, isYou: true }, { signed: false }] },
          { id: "ready", title: "Ready proposal", stage: "queued", state: "ready_to_send", canSign: false, canSend: true, signedCount: 2, threshold: 2, owners: [{ signed: true, isYou: true }, { signed: true }] },
        ] })
      : Response.json({ text: "Hi.", chips: [], max: 5000, blockNumber: 7, readAt: 1 })));
    wrap(<Greeting safeAddress="0xabc" onSend={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "Review and send" });
    expect(link.getAttribute("href")).toBe("/s/0xabc/proposals/ready");
    expect(screen.getByText("2 of 2 approved")).toBeTruthy();
  });
  it("uses the server queue-check instruction for a sending row without an approval count", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("/proposals/list")
      ? Response.json({ proposals: [{ id: "p-sending", title: "Open a loan", stage: "sending", state: null, signedCount: 0, threshold: undefined, sentence: "Safe submission outcome is being checked. Review your Safe queue; do not send this transaction again.", links: { tx: null, queue: "https://app.safe.global/queue" } }] })
      : Response.json({ text: "Hi.", chips: ["Borrow $5,000"], max: 5000, blockNumber: 7, readAt: 1 })));
    wrap(<Greeting safeAddress="0xabc" onSend={vi.fn()} />);
    expect(await screen.findByText(/Safe submission outcome is being checked/)).toBeTruthy();
    expect(screen.queryByText(/0 of .* approved/)).toBeNull();
    expect(screen.getByRole("link", { name: "Check Safe queue" }).getAttribute("href")).toBe("https://app.safe.global/queue");
    expect(screen.queryByRole("button", { name: "Borrow $5,000" })).toBeNull();
  });
});
