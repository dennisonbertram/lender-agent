// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertView } from "@/server/alerts/view";
import { MessageList } from "./MessageList";

vi.mock("@/components/shell/ShellContext", () => ({ useShell: () => ({ safe: { threshold: 2 }, agentOn: true }) }));

const alert: AlertView = {
  id: 7, loanId: "8453:0xsafe:compound-v3", chainId: 8453, lender: "compound-v3", reserveEligibility: { eligible: false, reason: "Reserve protection works only for Aave loans on Base." }, state: "live", tag: null, title: "Compound v3 loan is at risk", cause: null,
  hf: 1.3, liveHf: 1.3, warn: 1.6, act: 1.35, asset: "ETH", cushion: null, liquidatable: false, threshold: 2, createdAt: "2026-01-01T00:00:00Z", note: "", rule: null,
  options: [{ k: "repay", label: "Repay 1,000 USDC", addColl: 0, repay: 1000, hf: 1.7, sub: "$1,000 from your Safe", short: false, recommended: true }],
};
const draft = { id: "d1", title: "Repay 1,000 USDC on Compound v3", steps: ["Repay 1,000 USDC"], state: "draft", loanId: alert.loanId, chainId: 8453, option: "repay", healthBefore: 1.3, healthAfter: 1.7, testRunLine: "Checked: this would work.", canSend: true, urgent: false, urgentNote: null, stillNeeds: "It still needs 2 signatures.", proposalId: null };
const panel = (d: unknown) => ({ options: null, state: { fix: d ? "draft" : "none", replaced: [] }, draft: d, safeLink: null });
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage, { id: "m1", role: "assistant", parts: [{ type: "data-alert", data: { alertId: 7, loanId: alert.loanId, text: "Compound v3 loan is at risk." } }] } as UIMessage];

describe("MessageList alert card (E4 #6)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("choosing an option drafts the fix for the alert's loan and shows the fix card", async () => {
    let drafted = false;
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.mocked(fetch).mockImplementation((url, init) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (u.includes("/alerts/7")) return json({ alert });
      if (init?.method === "POST") { drafted = true; return json({ draft }); }
      return json(panel(drafted ? draft : null));
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MessageList messages={messages} safeAddress="0xsafe" onSend={() => {}} /></QueryClientProvider>);
    const option = await screen.findByText("Repay 1,000 USDC");
    expect((option.closest("button") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(option);
    expect(await screen.findByTestId("fix-draft")).toBeTruthy();
    expect(screen.getByText("Repay 1,000 USDC on Compound v3")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/safes/0xsafe/fixes");
    expect(JSON.parse(post.body!)).toEqual({ loanId: alert.loanId, option: "repay" });
  });

  it("a refused draft shows the reason and no fix card", async () => {
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (String(url).includes("/alerts/7")) return json({ alert });
      if (init?.method === "POST") return json({ error: "Not now." }, 409);
      return json(panel(null));
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MessageList messages={messages} safeAddress="0xsafe" onSend={() => {}} /></QueryClientProvider>);
    fireEvent.click(await screen.findByText("Repay 1,000 USDC"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Not now."));
    expect(screen.queryByTestId("fix-draft")).toBeNull();
  });

  it("shows the manual reserve action on the normal alert path and scopes its read to the current Safe", async () => {
    const calls: string[] = [];
    const eligibleAlert = { ...alert, lender: "aave-v3", reserveEligibility: { eligible: true, reason: null }, title: "The health factor is low", loanId: "8453:0xsafe:aave-v3" };
    vi.mocked(fetch).mockImplementation((url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/alerts/7")) return json({ alert: eligibleAlert });
      if (u.includes("/reserve/use-now?")) return json({
        enabled: true,
        label: "Runs now, without a signature",
        confirm: "Use up to $500 from reserve?",
        binding: {
          loanId: eligibleAlert.loanId, reserveSafe: "0xreserve", linkFingerprint: "fingerprint", triggerHf: 1.2,
          policyMaxRefillRaw: "1000000000", policyRefillRaw: "1000000000", policyPeriodRaw: "86400",
          allowanceBalanceRaw: "1000000000", allowanceTimestampRaw: "1", reserveBalanceRaw: "2000000000", maxAmountRaw: "500000000",
        },
      });
      return json(panel(null));
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MessageList messages={messages} safeAddress="0xsafe" onSend={() => {}} /></QueryClientProvider>);
    expect(await screen.findByRole("button", { name: /Use reserve now/ })).toBeTruthy();
    expect(calls).toContain("/api/safes/0xsafe/reserve/use-now?loanId=8453%3A0xsafe%3Aaave-v3");
    fireEvent.click(screen.getByRole("button", { name: /Use reserve now/ }));
    expect(await screen.findByText("Use up to $500 from reserve?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use reserve" })).toBeTruthy();
  });

  it("does not show a reserve action for an ineligible loan", async () => {
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation((url) => {
      calls.push(String(url));
      if (String(url).includes("/alerts/7")) return json({ alert: { ...alert, title: "Morpho Blue loan is at risk" } });
      return json(panel(null));
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MessageList messages={messages} safeAddress="0xsafe" onSend={() => {}} /></QueryClientProvider>);
    await screen.findByText("Morpho Blue loan is at risk");
    expect(screen.queryByRole("button", { name: /Use reserve now/ })).toBeNull();
    expect(screen.getByText(/This loan is not covered by Reserve protection. Reserve protection works only for Aave loans on Base./)).toBeTruthy();
    expect(calls.some((url) => url.includes("/reserve/use-now?"))).toBe(false);
  });

  it("does not query a reserve option for an Arbitrum alert", async () => {
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation((url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/alerts/7")) return json({ alert: { ...alert, chainId: 42161, loanId: "42161:0xsafe:aave-v3", title: "Aave loan is at risk" } });
      return json(panel(null));
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MessageList messages={messages} safeAddress="0xsafe" onSend={() => {}} /></QueryClientProvider>);
    await screen.findByText("Aave loan is at risk");
    expect(screen.getByText(/Reserve protection works only for Aave loans on Base/)).toBeTruthy();
    expect(calls.some((url) => url.includes("/reserve/use-now?"))).toBe(false);
  });
});

describe("MessageList follow-the-bottom", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const msg = (id: string, role: "user" | "assistant" = "assistant"): UIMessage => ({ id, role, parts: [{ type: "text", text: `text ${id}` }] }) as UIMessage;
  const qc = new QueryClient();
  const list = (ms: UIMessage[], localFollowVersion?: number) => <QueryClientProvider client={qc}><MessageList messages={ms} safeAddress="0xabc" onSend={() => {}} localFollowVersion={localFollowVersion} /></QueryClientProvider>;
  const scrollAway = (up: boolean) => {
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: up ? 100 : 600 });
    fireEvent.scroll(log);
  };
  let resize: (() => void) | undefined;
  let frame: FrameRequestCallback | undefined;
  const settleFrame = () => act(() => { frame?.(0); frame = undefined; });
  beforeEach(() => {
    resize = undefined;
    frame = undefined;
    qc.clear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
    });
  });
  it("follows new messages while at the bottom", () => {
    const { rerender } = render(list([msg("a")]));
    scrollAway(false);
    rerender(list([msg("a"), msg("b")]));
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(1000);
    expect(screen.queryByText(/New messages/)).toBeNull();
  });

  it("does not yank a scrolled-up reader; shows a button that scrolls down", () => {
    const { rerender } = render(list([msg("a")]));
    scrollAway(true);
    rerender(list([msg("a"), msg("b")]));
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: /New messages/ }));
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(1000);
    expect(screen.queryByText(/New messages/)).toBeNull();
  });

  it("does not treat a user message from history polling as a local send", () => {
    const { rerender } = render(list([msg("a")]));
    scrollAway(true);
    rerender(list([msg("a"), msg("remote-question", "user")]));
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: /New messages/ })).toBeTruthy();
  });

  it("still scrolls down when the reader sends a message", () => {
    const { rerender } = render(list([msg("a")], 0));
    scrollAway(true);
    rerender(list([msg("a"), msg("u", "user")], 1));
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(1000);
  });

  it("follows a locally posted plan after an explicit local follow request", () => {
    const { rerender } = render(list([msg("a")], 0));
    scrollAway(true);
    rerender(list([msg("a"), msg("local-plan")], 1));
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(1000);
  });

  it("keeps following after an ordinary action button is clicked", () => {
    const choices = { id: "choices", role: "assistant", parts: [{ type: "data-block", data: { block: { kind: "suggestions", items: ["Plan this"] } } }] } as UIMessage;
    render(list([choices]));
    const content = screen.getByRole("log").firstElementChild as HTMLElement;
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 500 });
    act(() => resize?.());
    scrollAway(false);
    fireEvent.click(screen.getByRole("button", { name: "Plan this" }));
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 700 });
    act(() => resize?.());
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(1000);
  });

  it("shows new incoming streamed text while preserving a reader's position", () => {
    const { rerender } = render(list([msg("a")]));
    scrollAway(true);
    rerender(list([{ ...msg("a"), parts: [{ type: "text", text: "streamed continuation" }] } as UIMessage]));
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: /New messages/ })).toBeTruthy();
  });

  it("follows content growth in the last message while the reader is at the bottom", () => {
    render(list([msg("a")]));
    const content = screen.getByRole("log").firstElementChild as HTMLElement;
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 500 });
    act(() => resize?.());
    scrollAway(false);
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 700 });
    act(() => resize?.());
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(1000);
  });

  it("stays pinned when the log viewport gets shorter", () => {
    render(list([msg("a")]));
    const log = screen.getByRole("log") as HTMLElement;
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400, writable: true });
    act(() => resize?.());
    scrollAway(false);
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 300, writable: true });
    act(() => resize?.());
    expect(log.scrollTop).toBe(1000);
  });

  it("ignores passive layout growth while the reader is above the bottom", () => {
    render(list([msg("a")]));
    const content = screen.getByRole("log").firstElementChild as HTMLElement;
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 500 });
    act(() => resize?.());
    scrollAway(true);
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 700 });
    act(() => resize?.());
    expect((screen.getByRole("log") as HTMLElement).scrollTop).toBe(100);
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();
  });

  it("does not snap to the bottom when the reader opens an add-funds disclosure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ address: "0xabc", networks: ["base"], assets: ["ETH"], text: "Send ETH to this Safe." })));
    const addFunds = { id: "funds", role: "assistant", parts: [{ type: "data-block", data: { block: { kind: "addfunds" } } }] } as UIMessage;
    render(list([msg("old", "user"), addFunds]));
    const summary = await screen.findByText("Add funds to this Safe");
    const log = screen.getByRole("log");
    const content = log.firstElementChild as HTMLElement;
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 500 });
    act(() => resize?.());
    scrollAway(false);
    fireEvent.click(summary); // Close, then reopen the historical disclosure.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 700 });
    settleFrame();
    fireEvent.click(summary);
    settleFrame();
    act(() => resize?.());
    expect((log as HTMLElement).scrollTop).toBe(600);
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();
  });

  it("re-enables following after a disclosure toggle when the transcript still fits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ address: "0xabc", networks: ["base"], assets: ["ETH"], text: "Send ETH to this Safe." })));
    const addFunds = { id: "funds", role: "assistant", parts: [{ type: "data-block", data: { block: { kind: "addfunds" } } }] } as UIMessage;
    const { rerender } = render(list([msg("old", "user"), addFunds]));
    const summary = await screen.findByText("Add funds to this Safe");
    const log = screen.getByRole("log") as HTMLElement;
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: 0 });
    fireEvent.click(summary); // Collapse the disclosure.
    settleFrame();
    fireEvent.click(summary); // Expand it again; the short thread still fits.
    settleFrame();
    rerender(list([msg("old", "user"), addFunds, msg("next")]));
    expect(log.scrollTop).toBe(300);
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();
  });
});

describe("MessageList suggestion chips", () => {
  it("only the latest agent message keeps its chips", () => {
    const chips = (id: string, item: string) => ({ id, role: "assistant", parts: [{ type: "data-block", data: { block: { kind: "suggestions", items: [item] } } }] }) as UIMessage;
    render(<QueryClientProvider client={new QueryClient()}><MessageList messages={[chips("a", "Old chip"), { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage, chips("b", "New chip")]} safeAddress="0xabc" onSend={() => {}} /></QueryClientProvider>);
    expect(screen.queryByText("Old chip")).toBeNull();
    expect(screen.getByText("New chip")).toBeTruthy();
    cleanup();
  });
  it("one reply shows its chips once", () => {
    const m = { id: "a", role: "assistant", parts: [
      { type: "data-block", data: { block: { kind: "suggestions", items: ["Compare lenders"] } } },
      { type: "tool-suggest", toolCallId: "c", state: "output-available", input: {}, output: { kind: "suggestions", items: ["Compare lenders"] } },
    ] } as unknown as UIMessage;
    render(<QueryClientProvider client={new QueryClient()}><MessageList messages={[m]} safeAddress="0xabc" onSend={() => {}} /></QueryClientProvider>);
    expect(screen.getAllByText("Compare lenders")).toHaveLength(1);
    cleanup();
  });
});
