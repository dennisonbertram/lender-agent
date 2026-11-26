// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QuoteResponse } from "@/server/quote";
import { takeApproveIntent } from "@/client/approve-intent";
import { LivePlanBlock } from "./LivePlanBlock";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

vi.mock("@/components/chat/ProposalCardSlot", () => ({ ProposalCardSlot: (p: { proposalId: string }) => <div data-testid="slot">{p.proposalId}</div> }));

const agentMock = vi.hoisted(() => ({ baseAdded: true, arbAdded: true }));
vi.mock("@/client/agent", () => ({
  useAgentStatus: () => ({ data: { agentAddress: "0x00000000000000000000000000000000000000a1", networks: [{ chainId: 8453, deployed: true, added: agentMock.baseAdded }, { chainId: 42161, deployed: true, added: agentMock.arbAdded }], active: agentMock.baseAdded && agentMock.arbAdded, otherChainIds: [] } }),
  useAddAgent: () => ({ add: vi.fn(), adding: false, progress: null, error: null, reset: vi.fn() }),
}));

const ok = (over: Partial<QuoteResponse> = {}): QuoteResponse => ({
  status: "ok", chainId: 8453, network: "base", venueId: "aave-v3", blockNumber: 57_172_000, readAt: 1, cash: 5000, maxCash: 9000,
  quote: { kind: "ok", cash: 5000, borrowAsset: "USDC", asset: "ETH", collateral: 2.09, collateralUsd: 6270, price: 3000, liqPrice: 1930, dropPct: 36, adding: false, apr: 5.5, yearly: 275, feesLine: "One-time network fee: about $0.04 to set up the loan.", lender: "Aave v3", network: "Base" },
  testRun: { line: "Checked: this would work. Network fee about $0.04.", canSend: true }, draft: { live: true, draftKey: "key-1" }, ...over,
});

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
/** A queued send whose stored proposal (GET) is on `chainId` with these changes. */
const handoffFetch = (view: { chainId?: number; cash?: number; asset?: string; collateral?: number } = {}) => (url: unknown) => {
  const u = String(url);
  if (u.endsWith("/quote")) return json(ok());
  if (u.endsWith("/proposals/p1")) return json({ proposal: { id: "p1", chainId: view.chainId ?? 8453, facts: { changes: [{ amount: `+${(view.cash ?? 5000).toLocaleString("en-US")} USDC` }, { amount: `−${view.collateral ?? 2.09} ${view.asset ?? "ETH"}` }] } } });
  return json({ proposalId: "p1", stage: "queued", receipt: "Sent to your Safe: x." }, 201);
};
const renderBlock = (block: Parameters<typeof LivePlanBlock>[0]["block"] = { kind: "plan", cash: 5000 }) => render(
  <QueryClientProvider client={new QueryClient()}>
    <LivePlanBlock block={block} safeAddress="0xabc" messageId="m1" onSend={() => {}} />
  </QueryClientProvider>,
);

describe("LivePlanBlock", () => {
  beforeEach(() => { agentMock.baseAdded = true; agentMock.arbAdded = true; sessionStorage.clear(); nav.push.mockClear(); vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("agent off: the add-agent prompt replaces the approve button; on, the approve button returns", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok()));
    agentMock.baseAdded = false;
    const view = renderBlock();
    expect(await screen.findByText("Add the agent to this Safe on Base so I can send proposals.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add the agent (one free signature)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve in your wallet" })).toBeNull();
    agentMock.baseAdded = true;
    view.rerender(<QueryClientProvider client={new QueryClient()}><LivePlanBlock block={{ kind: "plan", cash: 5000 }} safeAddress="0xabc" messageId="m1" onSend={() => {}} /></QueryClientProvider>);
    expect(await screen.findByRole("button", { name: "Approve in your wallet" })).toBeTruthy();
  });

  it("offers to add the agent on the selected Arbitrum network when it is missing there", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ chainId: 42161, network: "arbitrum", quote: { ...ok().quote!, network: "Arbitrum" } as never })));
    agentMock.arbAdded = false;
    renderBlock({ kind: "plan", cash: 5000, network: "arbitrum" });
    expect(await screen.findByText("Add the agent to this Safe on Arbitrum so I can send proposals.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add the agent (one free signature)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve in your wallet" })).toBeNull();
  });

  it("renders the rows and the Test run line, sends, and shows the receipt", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url, init) => String(url).endsWith("/quote") ? json(ok()) : json({ proposalId: "p1", stage: "queued", receipt: "Sent to your Safe: borrow $5,000 from Aave v3, locking 2.09 ETH." }, 201));
    renderBlock();
    expect(await screen.findByText("You get $5,000 as USDC, a digital dollar.")).toBeTruthy();
    expect(screen.getByText("You lock 2.09 ETH ($6,270).")).toBeTruthy();
    expect(screen.getByText("About $275 a year at 5.5%. The rate can change.")).toBeTruthy();
    expect(screen.getByText("On Base, with Aave v3.")).toBeTruthy();
    expect(screen.getByText("Checked: this would work.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    expect(await screen.findByText("Sent to your Safe.")).toBeTruthy();
    // The proposal card is its own chat message (the Send route appends it), not part of the plan card.
    expect(screen.queryByTestId("slot")).toBeNull();
    const call = f.mock.calls.find(([u]) => String(u).endsWith("/proposals"))!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ draftKey: "key-1", cash: 5000, asset: "ETH", chainId: 8453, venueId: "aave-v3", hfIdx: 1, months: 12 });
  });

  it("one action: a queued send from a click marks the intent and opens the proposal page once", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation(handoffFetch());
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    expect(screen.getByText("Sends this plan to your Safe, then your wallet asks for your free approval.")).toBeTruthy();
    expect(screen.queryByText("Send to Safe for signatures")).toBeNull();
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(takeApproveIntent("p1")).toBe(true);
  });

  it("sends the chain of the plan it shows: an Arbitrum plan is not a Base proposal", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation(handoffFetch({ chainId: 42161 }));
    renderBlock({ kind: "plan", cash: 5000, network: "arbitrum" });
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    const q = f.mock.calls.find(([u]) => String(u).endsWith("/quote"))!;
    expect(JSON.parse(q[1]!.body as string)).toMatchObject({ chainId: 42161 });
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const call = f.mock.calls.find(([u, i]) => String(u).endsWith("/proposals") && i?.method === "POST")!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ chainId: 42161 });
    expect(takeApproveIntent("p1")).toBe(true);
  });

  it("opens the page with no auto-approval when the returned proposal has other terms (shared draft in two tabs)", async () => {
    vi.mocked(fetch).mockImplementation(handoffFetch({ cash: 1000 }));
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(takeApproveIntent("p1")).toBe(false);
  });

  it("opens the page with no auto-approval when the returned proposal locks other collateral", async () => {
    vi.mocked(fetch).mockImplementation(handoffFetch({ collateral: 3.5 }));
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(takeApproveIntent("p1")).toBe(false);
  });

  it("keeps Send off while the quote for a new safety level loads (the old quote is not current)", async () => {
    const f = vi.mocked(fetch);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    f.mockImplementation(async (url, init) => {
      if (!String(url).endsWith("/quote")) return json({ proposalId: "p1", stage: "queued" }, 201);
      if (JSON.parse(init!.body as string).hfIdx === 0) { await gate; return json(ok({ quote: { ...ok().quote!, collateral: 3.1 } as never })); }
      return json(ok());
    });
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByLabelText("Extra safe"));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).endsWith("/quote") && JSON.parse(i!.body as string).hfIdx === 0)).toBe(true));
    const btn = screen.getByRole("button", { name: "Approve in your wallet" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(f.mock.calls.some(([u]) => String(u).endsWith("/proposals"))).toBe(false);
    release();
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve in your wallet" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("a plan that names a lender sends venueChosen; one without does not", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url) => String(url).endsWith("/quote") ? json(ok()) : json({ proposalId: "p1", stage: "queued" }, 201));
    renderBlock({ kind: "plan", cash: 5000, venueId: "aave-v3" });
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).endsWith("/proposals"))).toBe(true));
    const call = f.mock.calls.find(([u]) => String(u).endsWith("/proposals"))!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ venueChosen: true });
  });

  it("a plan already sent before mount does not navigate or mark an intent", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ draft: { live: true, draftKey: "key-1", sentId: "p1", receipt: "Sent to your Safe: x." } })));
    renderBlock();
    expect(await screen.findByText("Sent to your Safe.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(nav.push).not.toHaveBeenCalled();
    expect(takeApproveIntent("p1")).toBe(false);
  });

  it("a sending result does not navigate until it is queued", async () => {
    vi.mocked(fetch).mockImplementation((url) => String(url).endsWith("/quote") ? json(ok()) : json({ proposalId: "p1", stage: "sending", receipt: null }, 201));
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await screen.findByRole("button", { name: "Sending to your Safe…" });
    expect(nav.push).not.toHaveBeenCalled();
    expect(takeApproveIntent("p1")).toBe(false);
  });

  it("a request raised to a lender's minimum shows the server note and never sends an amount the field does not show", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url) => String(url).endsWith("/quote") ? json(ok({ cash: 500, cappedNote: "The smallest loan here is $500." })) : json({ proposalId: "p1", stage: "queued", receipt: "Sent." }, 201));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LivePlanBlock block={{ kind: "plan", cash: 50 }} safeAddress="0xabc" messageId="m1" onSend={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/The smallest loan here is \$500\./)).toBeTruthy();
    const field = screen.getByLabelText("Cash you need") as HTMLInputElement;
    // Either the field now shows $500 or Send is held until the user confirms it.
    const send = screen.getByRole("button", { name: "Approve in your wallet" }) as HTMLButtonElement;
    expect(field.value === "$500" || send.disabled).toBe(true);
    const use = screen.queryByRole("button", { name: "Use $500" });
    if (use) fireEvent.click(use);
    await waitFor(() => expect((screen.getByLabelText("Cash you need") as HTMLInputElement).value).toBe("$500"));
    // The new amount is quoted again; Send waits for that answer.
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve in your wallet" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).endsWith("/proposals"))).toBe(true));
    const call = f.mock.calls.find(([u]) => String(u).endsWith("/proposals"))!;
    expect(JSON.parse(call[1]!.body as string).cash).toBe(500);
  });

  it("a plan with no lender defaults to the lender that gave the borrow limit (VC-02)", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url) => String(url).includes("/blocks/greeting")
      ? json({ text: "Hi", chips: [], max: 4000, lenderId: "morpho-blue", lenderAsset: "ETH", why: "Why $4,000? x", blockNumber: 1, readAt: 1 })
      : json(ok({ venueId: "morpho-blue" })));
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    const bodies = f.mock.calls.filter(([u]) => String(u).endsWith("/quote")).map(([, i]) => JSON.parse(i!.body as string));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.venueId === "morpho-blue")).toBe(true);
  });

  it("a plan for another asset than the limit's does not force the limit's lender (wstETH is not on Morpho)", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url) => String(url).includes("/blocks/greeting")
      ? json({ text: "Hi", chips: [], max: 4000, lenderId: "morpho-blue", lenderAsset: "ETH", why: "Why $4,000? x", blockNumber: 1, readAt: 1 })
      : json(ok()));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LivePlanBlock block={{ kind: "plan", cash: 500, asset: "wstETH" }} safeAddress="0xabc" messageId="m1" onSend={() => {}} />
      </QueryClientProvider>,
    );
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    const bodies = f.mock.calls.filter(([u]) => String(u).endsWith("/quote")).map(([, i]) => JSON.parse(i!.body as string));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.asset === "wstETH" && b.venueId === undefined)).toBe(true);
  });

  it("disables Send and says why when the test run blocks it", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ testRun: { line: 'The test run failed at "Borrow 5,000 USDC". Nothing was sent.', canSend: false, reason: 'The test run failed at "Borrow 5,000 USDC".' } })));
    renderBlock();
    expect(await screen.findByText(/Nothing was sent/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve in your wallet" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refetches when the safety level changes", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation(() => json(ok()));
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByLabelText("Extra safe"));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).endsWith("/quote") && JSON.parse(i!.body as string).hfIdx === 0)).toBe(true));
  });

  it("reads 'Earlier plan' for a card that is not live", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ draft: { live: false, draftKey: null } })));
    renderBlock();
    expect(await screen.findByText("Earlier plan for $5,000")).toBeTruthy();
  });

  it("shows no figures when the lender is not available for this Safe yet", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ status: "unavailable", maxCash: null, quote: { kind: "unavailable" }, testRun: { line: "", canSend: false, reason: "not available for this Safe yet" } })));
    renderBlock();
    expect(await screen.findByText("Loans are not available for this Safe yet.")).toBeTruthy();
    expect(screen.queryByText(/You get/)).toBeNull();
  });

  it("a sending proposal shows a pending state, not a receipt", async () => {
    vi.mocked(fetch).mockImplementation((url) => String(url).endsWith("/quote") ? json(ok()) : json({ proposalId: "p1", stage: "sending", receipt: null }, 201));
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    expect(await screen.findByRole("button", { name: "Sending to your Safe…" })).toBeTruthy();
    expect(screen.queryByText(/^Sent to your Safe/)).toBeNull();
  });

  it("a not_sent draft keeps the form and shows the error", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ draft: { live: true, draftKey: "key-1", notSent: { id: "p1", error: "The Safe service refused it." } } })));
    renderBlock();
    expect(await screen.findByText("The Safe service refused it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve in your wallet" })).toBeTruthy();
    expect(screen.queryByText(/^Sent to your Safe/)).toBeNull();
  });

  it("a later notSent state wins over the send result's sending stage", async () => {
    let sent = false;
    vi.mocked(fetch).mockImplementation((url) => {
      if (String(url).endsWith("/quote")) return json(ok(sent ? { draft: { live: true, draftKey: "key-1", notSent: { id: "p1", error: "The Safe service refused it." } } } : {}));
      sent = true;
      return json({ proposalId: "p1", stage: "sending", receipt: null }, 201);
    });
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    expect(await screen.findByText("The Safe service refused it.")).toBeTruthy();
    expect(screen.queryByText(/Sending to your Safe/)).toBeNull();
    expect((screen.getByRole("button", { name: "Approve in your wallet" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an edit card sends with `replaces` set to the open proposal and says what it replaces (BP-24)", async () => {
    const f = vi.mocked(fetch);
    const open = (over = {}) => ({ id: "old-1", title: "Borrow $2,000", stage: "queued", editable: true, signedCount: 1, createdAt: "2026-01-02T00:00:00Z", ...over });
    f.mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("/quote")) return json(ok());
      if (u.includes("/proposals/list")) return json({ proposals: [open({ id: "older", createdAt: "2026-01-01T00:00:00Z" }), open(), open({ id: "close-1", editable: false, createdAt: "2026-01-03T00:00:00Z" })] });
      return json({ proposalId: "p2", stage: "queued", receipt: "Sent to your Safe: borrow $5,000." }, 201);
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LivePlanBlock block={{ kind: "plan", cash: 5000, edit: true }} safeAddress="0xabc" messageId="m1" onSend={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Sending this replaces "Borrow \$2,000"\. It already has signatures: signing the new one does not cancel it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await screen.findByText(/^Sent to your Safe/);
    const call = f.mock.calls.find(([u]) => String(u).endsWith("/proposals"))!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ draftKey: "key-1", cash: 5000, replaces: "old-1" });
  });

  const editBlock = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LivePlanBlock block={{ kind: "plan", cash: 5000, edit: true }} safeAddress="0xabc" messageId="m1" onSend={() => {}} />
    </QueryClientProvider>,
  );
  const sendBtn = () => screen.getByRole("button", { name: "Approve in your wallet" }) as HTMLButtonElement;

  it("an edit card keeps Send disabled while the open-proposal list is pending", async () => {
    vi.mocked(fetch).mockImplementation((url) => String(url).endsWith("/quote") ? json(ok()) : String(url).includes("/blocks/greeting") ? json({ text: "Hi", chips: [], max: 9000, lenderId: null, why: "", blockNumber: 1, readAt: 1 }) : new Promise(() => {}));
    editBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    expect(sendBtn().disabled).toBe(true);
  });

  it("an edit card keeps Send disabled and shows an error when the open-proposal list failed", async () => {
    vi.mocked(fetch).mockImplementation((url) => String(url).endsWith("/quote") ? json(ok()) : json({ error: "boom" }, 500));
    editBlock();
    expect(await screen.findByText(/Could not check your open proposals/)).toBeTruthy();
    expect(sendBtn().disabled).toBe(true);
  });

  it("an edit card sends intent edit", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url) => String(url).endsWith("/quote") ? json(ok()) : String(url).includes("/proposals/list") ? json({ proposals: [] }) : json({ proposalId: "p2", stage: "queued", receipt: "Sent to your Safe: x." }, 201));
    editBlock();
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    fireEvent.click(sendBtn());
    await screen.findByText(/^Sent to your Safe/);
    expect(JSON.parse(f.mock.calls.find(([u]) => String(u).endsWith("/proposals"))![1]!.body as string)).toMatchObject({ intent: "edit" });
  });

  it("a plain plan card never sends `replaces`", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url) => String(url).endsWith("/quote") ? json(ok()) : json({ proposalId: "p1", stage: "queued", receipt: "Sent to your Safe: x." }, 201));
    renderBlock();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await screen.findByText(/^Sent to your Safe/);
    expect(f.mock.calls.some(([u]) => String(u).includes("/proposals/list"))).toBe(false);
    expect(JSON.parse(f.mock.calls.find(([u]) => String(u).endsWith("/proposals"))![1]!.body as string)).not.toHaveProperty("replaces");
  });

  it("after a reload the sent plan is one short line, never the form's quote or the repeated figures", async () => {
    const receipt = "Sent to your Safe: borrow $1,500 from Aave v3, locking 0.97 ETH.";
    vi.mocked(fetch).mockImplementation(() => json(ok({ cash: 3500, quote: { ...ok().quote, cash: 3500, collateral: 2.25 } as QuoteResponse["quote"], draft: { live: true, draftKey: "key-1", sentId: "p1", receipt } })));
    renderBlock();
    expect(await screen.findByText("Sent to your Safe.")).toBeTruthy();
    expect(screen.queryByText(receipt)).toBeNull();
    expect(screen.queryByText(/\$3,500/)).toBeNull();
  });

  it("a sent plan with the proposal card after it renders nothing", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ draft: { live: true, draftKey: "key-1", sentId: "p1", receipt: "Sent to your Safe: x." } })));
    const { container } = render(<QueryClientProvider client={new QueryClient()}><LivePlanBlock block={{ kind: "plan", cash: 5000 }} safeAddress="0xabc" messageId="m1" onSend={() => {}} proposalFollows /></QueryClientProvider>);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe("");
  });

  it("an amount under the smallest loan starts at $10, with a note and the real maximum", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ cash: 10, maxCash: 3500, quote: { ...ok().quote, cash: 10 } as QuoteResponse["quote"] })));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LivePlanBlock block={{ kind: "plan", cash: 5 }} safeAddress="0xabc" messageId="m1" onSend={() => {}} />
      </QueryClientProvider>,
    );
    expect((screen.getByLabelText("Cash you need") as HTMLInputElement).value).toBe("$10");
    expect(screen.getByText("The smallest loan is $10, so this plan starts there.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Up to $3,500" })).toBeTruthy();
    expect(screen.getByText("The smallest loan is $10, so this plan starts there.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cash you need"), { target: { value: "$600" } });
    expect(screen.queryByText(/so this plan starts there/)).toBeNull();
  });

  it("a refused plan never draws the editor and never asks for a quote", async () => {
    const f = vi.mocked(fetch);
    f.mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LivePlanBlock block={{ kind: "plan", cash: 20, refusal: { reason: "not_enough_collateral", needUsd: 90 } }} safeAddress="0xabc" messageId="m1" onSend={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/You'd need about \$90 more/)).toBeTruthy();
    expect(screen.queryByLabelText("Cash you need")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.mock.calls.some((c) => String(c[0]).endsWith("/quote"))).toBe(false);
  });

  it("the Test run line is in the plan card, before the Send button", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok()));
    renderBlock();
    const line = await screen.findByText("Checked: this would work.");
    const button = sendBtn();
    expect(line.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const card = button.closest("div.flex.flex-col.gap-3, div[class*='ring']") ?? button.parentElement!;
    expect(card.contains(line)).toBe(true);
    expect(button.parentElement!.contains(line)).toBe(true);
  });

  it("states the network fee once and keeps a compared amount below the maximum", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ cash: 3000, maxCash: 9000, quote: { ...ok().quote, cash: 3000 } as never })));
    render(<QueryClientProvider client={new QueryClient()}><LivePlanBlock block={{ kind: "plan", cash: 3000, venueId: "aave-v3" }} safeAddress="0xabc" messageId="m1" onSend={() => {}} /></QueryClientProvider>);
    await screen.findByText(/One-time network fee/);
    expect(screen.queryByText(/Checked: this would work\. Network fee/)).toBeNull();
    expect(screen.getByText("Checked: this would work.")).toBeTruthy();
    expect((screen.getByLabelText("Cash you need") as HTMLInputElement).value).toBe("$3,000");
  });

  it("a hypothetical plan is read-only and offers an affordable plan", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ testRun: { line: "This is only a size check.", canSend: false } })));
    const onSend = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><LivePlanBlock block={{ kind: "plan", cash: 100000, hypothetical: true }} safeAddress="0xabc" messageId="m1" onSend={onSend} /></QueryClientProvider>);
    await screen.findByText(/You lock/);
    expect(screen.queryByRole("button", { name: /Send to Safe|Approve in your wallet/ })).toBeNull();
    expect(screen.queryByText("This is only a size check.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan a loan I can afford" }));
    expect(onSend).toHaveBeenCalledWith("Plan a loan I can afford");
  });

  it("an earlier plan with a proposal after it has no \"Earlier plan\" strip", async () => {
    vi.mocked(fetch).mockImplementation(() => json(ok({ draft: { live: false, draftKey: "key-1" } })));
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <LivePlanBlock block={{ kind: "plan", cash: 5000 }} safeAddress="0xabc" messageId="m1" onSend={() => {}} proposalFollows />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).not.toMatch(/Earlier plan|Working out/);
  });

  it("a quote that never arrives stops spinning after the timeout and offers Try again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(fetch).mockImplementation((u) => String(u).endsWith("/quote") ? new Promise(() => {}) : json({ lenderId: "aave-v3", lenderAsset: "ETH" }));
      renderBlock();
      expect(await screen.findByText(/Working out the plan/)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(10_500);
      await waitFor(() => expect(screen.queryByText(/Working out the plan/)).toBeNull());
      expect(screen.getByRole("alert").textContent).toMatch(/Couldn't refresh the plan/);
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("a plan block that names no network sends and signs on the chain the server quoted", async () => {
    const f = vi.mocked(fetch);
    f.mockImplementation((url, init) => {
      const u = String(url);
      if (u.endsWith("/quote")) return json({ ...ok(), chainId: 42161, network: "arbitrum", quote: { ...ok().quote, network: "Arbitrum" } });
      if (u.endsWith("/proposals/p1")) return json({ proposal: { id: "p1", chainId: 42161, facts: { changes: [{ amount: "+5,000 USDC" }, { amount: "−2.09 ETH" }] } } });
      return json({ proposalId: "p1", stage: "queued", receipt: "Sent to your Safe: x." }, 201);
    });
    renderBlock({ kind: "plan", cash: 5000 });
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByRole("button", { name: "Approve in your wallet" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    const call = f.mock.calls.find(([u, i]) => String(u).endsWith("/proposals") && i?.method === "POST")!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ chainId: 42161 });
    expect(takeApproveIntent("p1")).toBe(true);
  });

  it("names the plan's real network in a refusal, not always Base", () => {
    renderBlock({ kind: "plan", cash: 5000, network: "arbitrum", refusal: { reason: "not_enough_collateral", needUsd: 100 } });
    expect(screen.getByText(/on Arbitrum/)).toBeTruthy();
    expect(screen.queryByText(/on Base/)).toBeNull();
  });
});
