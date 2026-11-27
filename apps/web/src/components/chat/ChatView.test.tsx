// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ShellProvider, type ShellLoan } from "@/components/shell/ShellContext";
import type { Safe } from "@/lib/types";
import { ChatView } from "./ChatView";

vi.mock("@/components/chat/Greeting", () => ({ Greeting: () => <div data-testid="greeting" /> }));
vi.mock("@/components/chat/LiveBlock", () => ({ LiveBlock: ({ block }: { block: { kind: string } }) => <div data-testid="block">{block.kind}</div> }));
vi.mock("@/components/chat/ProposalCardSlot", () => ({ ProposalCardSlot: ({ proposalId }: { proposalId: string }) => <div data-testid="proposal">{proposalId}</div> }));

const agentMock = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/client/agent", () => ({
  useAddAgent: () => ({ add: agentMock.add, adding: false, progress: null, error: null, reset: vi.fn() }),
  useAgentStatus: () => ({ data: { agentAddress: "0x00000000000000000000000000000000000000a1", networks: [{ chainId: 8453, deployed: true, added: false }], active: false, otherChainIds: [] } }),
}));

const safe: Safe = { id: "0xabc", name: "Main Safe", address: "0xabc", threshold: "2/2", agent: true, networks: [], balances: {} };

const loan: ShellLoan = { id: "l1", safeId: "s1", network: "base", venue: "Aave v3", collAsset: "ETH", collAmount: 2, debtAsset: "USDC", debt: 3000, lt: 0.8, apr: 3.4, accrued: 0, hf: 1.5, status: "watch" };
const wrap = (ui: ReactNode, { agentOn = true, watching = true, failing = false, starting = false, loans = [] as ShellLoan[] } = {}) => (
  <QueryClientProvider client={new QueryClient()}>
    <ShellProvider safe={safe} safes={[safe]} loans={loans} agentOn={agentOn} watching={watching} failing={failing} starting={starting}>{ui}</ShellProvider>
  </QueryClientProvider>
);

const thread = (messages: unknown[]) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messages }), { status: 200 })));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ChatView", () => {
  it("shows the greeting slot on an empty thread, in a log", async () => {
    thread([]);
    render(wrap(<ChatView address="0xabc" />));
    const log = await screen.findByRole("log");
    expect(log.getAttribute("aria-label")).toBe("Conversation with Lender agent");
    expect(screen.getByTestId("greeting")).toBeTruthy();
    expect(screen.getByPlaceholderText("Ask anything, or say how much you need")).toBeTruthy();
    expect(screen.getByText("Ready. No loans to watch yet.")).toBeTruthy();
  });

  it("replaces the composer with the agent-off notice when the agent is off", async () => {
    thread([]);
    render(wrap(<ChatView address="0xabc" />, { agentOn: false, watching: false }));
    await screen.findByRole("log");
    expect(screen.getByText("Add the Lender agent to suggest plans. It can suggest transactions; it cannot sign or move money.")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Ask anything, or say how much you need")).toBeNull();
    expect(screen.getByText("Not watching this Safe")).toBeTruthy();
  });

  it("shows the composer once the agent is added from the notice", async () => {
    thread([]);
    agentMock.add.mockResolvedValue({ active: true });
    render(wrap(<ChatView address="0xabc" />, { agentOn: false, watching: false }));
    await screen.findByRole("log");
    fireEvent.click(screen.getByRole("button", { name: "Add the agent (one free signature)" }));
    expect(await screen.findByPlaceholderText("Ask anything, or say how much you need")).toBeTruthy();
    expect(screen.queryByText(/Add the Lender agent to suggest plans/)).toBeNull();
  });

  it("says it is not watching when the worker is unhealthy (no fake freshness)", async () => {
    thread([]);
    render(wrap(<ChatView address="0xabc" />, { watching: false }));
    await screen.findByRole("log");
    expect(screen.getByText("Ready. No loans to watch yet.")).toBeTruthy();
    expect(screen.queryByText(/^Watching/)).toBeNull();
  });

  it("says the first check is on its way while the agent is on and the worker is alive but this Safe has not been checked yet", async () => {
    thread([]);
    render(wrap(<ChatView address="0xabc" />, { watching: false, failing: false, starting: true }));
    await screen.findByRole("log");
    expect(screen.getByText("Getting ready. First check in about a minute.")).toBeTruthy();
    expect(screen.queryByText(/Not watching right now/)).toBeNull();
  });

  it("does not show the alarming check-failure line when the Safe has no loan", async () => {
    thread([]);
    render(wrap(<ChatView address="0xabc" />, { watching: false, failing: true }));
    await screen.findByRole("log");
    expect(screen.queryByText(/Checks delayed/)).toBeNull();
    expect(screen.getByText("Ready. No loans to watch yet.")).toBeTruthy();
  });

  it("says so when the checks are failing and does not claim to be watching (BP-18)", async () => {
    thread([]);
    render(wrap(<ChatView address="0xabc" />, { watching: false, failing: true, loans: [loan] }));
    await screen.findByRole("log");
    expect(screen.getByText("Not checked yet")).toBeTruthy();
    expect(screen.queryByText(/Not watching\./)).toBeNull();
    expect(screen.queryByText(/^Watching/)).toBeNull();
  });

  it("renders text, tool blocks, data-block and proposal cards from the stored thread, and drops errored tools", async () => {
    thread([
      { id: "u1", role: "user", parts: [{ type: "text", text: "I need $12k" }] },
      { id: "a1", role: "assistant", parts: [
        { type: "text", text: "Here is a plan. Change anything below." },
        { type: "tool-planLoan", toolCallId: "c", state: "output-available", input: { cash: 12000 }, output: { kind: "plan", cash: 12000 } },
        { type: "tool-explain", toolCallId: "d", state: "output-error", input: {}, errorText: "bad" },
      ] },
      { id: "a2", role: "assistant", parts: [{ type: "data-block", data: { block: { kind: "status" } } }] },
      { id: "s1", role: "assistant", parts: [{ type: "data-proposal", data: { proposalId: "p-1" } }] },
    ]);
    render(wrap(<ChatView address="0xabc" />));
    await waitFor(() => expect(screen.getByText("I need $12k")).toBeTruthy());
    // The plan was sent (a proposal card follows), so its lead-in is gone.
    expect(screen.queryByText("Here is a plan. Change anything below.")).toBeNull();
    expect(screen.getAllByTestId("block").map((b) => b.textContent)).toEqual(["plan", "status"]);
    expect(screen.getByTestId("proposal").textContent).toBe("p-1");
    expect(screen.queryByTestId("greeting")).toBeNull();
  });

  it("explains a 403 instead of crashing and never offers Add Agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 403 })));
    render(wrap(<ChatView address="0xabc" />, { agentOn: false }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/owner of this Safe on every network/);
    expect(screen.queryByText(/Add the Lender agent to suggest plans/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Add the agent/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Check access again" })).toBeTruthy();
  });

  it("keeps the ownership state after an initial 403 and transient access-check failure", async () => {
    let denied = true;
    vi.stubGlobal("fetch", vi.fn(async () => denied
      ? new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
      : new Response(JSON.stringify({ error: "unavailable" }), { status: 500 })));
    render(wrap(<ChatView address="0xabc" />, { agentOn: false }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/owner of this Safe on every network/);
    denied = false;
    fireEvent.click(screen.getByRole("button", { name: "Check access again" }));
    expect(await screen.findByText(/We could not confirm access/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/owner of this Safe on every network/);
    expect(screen.queryByText(/Add the Lender agent to suggest plans/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Add the agent/ })).toBeNull();
  });

  it("keeps a locked composer in place while loading and after a failed load", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    render(wrap(<ChatView address="0xabc" />));
    const input = screen.getByPlaceholderText("Ask anything, or say how much you need") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    resolve(new Response("{}", { status: 500 }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect((screen.getByPlaceholderText("Ask anything, or say how much you need") as HTMLInputElement).disabled).toBe(true);
  });

  it("a failed load offers Try again, which loads the thread", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => (fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ messages: [] }), { status: 200 }))));
    render(wrap(<ChatView address="0xabc" />));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load the conversation/);
    expect((screen.getByPlaceholderText("Ask anything, or say how much you need") as HTMLInputElement).disabled).toBe(true);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("log")).toBeTruthy();
  });

  it("shows a skeleton while loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(wrap(<ChatView address="0xabc" />));
    expect(screen.getByRole("status", { name: "Loading the conversation" })).toBeTruthy();
    expect((screen.getByPlaceholderText("Ask anything, or say how much you need") as HTMLInputElement).disabled).toBe(true);
    expect(document.querySelector('[data-guide-target="chat-compose"]')).toBeNull();
  });

  it("exposes the guide target only on the live composer", async () => {
    thread([]);
    render(wrap(<ChatView address="0xabc" />));
    await screen.findByRole("log");
    expect(screen.getByLabelText("Message").getAttribute("data-guide-target")).toBe("chat-compose");
  });

  it("names the network and the Safe under the agent's name, with copy, explorer and Open in Safe", async () => {
    thread([]);
    const s = { ...safe, address: "0x5afe000000000000000000000000000000000001", networks: [{ id: "base" as const, deployed: true, agent: true }] };
    render(<QueryClientProvider client={new QueryClient()}><ShellProvider safe={s} safes={[s]} loans={[]} agentOn watching><ChatView address={s.address} /></ShellProvider></QueryClientProvider>);
    await screen.findByRole("log");
    expect(screen.getByText("Base")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View on Basescan" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
  });

  describe("live thread polling", () => {
    const m = (id: string, text: string) => ({ id, role: "assistant", parts: [{ type: "text", text }] });
    const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const setVisibility = (v: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); setVisibility("visible"); });
    afterEach(() => { vi.useRealTimers(); setVisibility("visible"); });

    it("hides old history after a polling 403 and requires a successful access check to restore chat", async () => {
      let mode: "allowed" | "denied" | "transient" = "allowed";
      let recovered = false;
      vi.stubGlobal("fetch", vi.fn(async () => {
        if (mode === "denied") return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
        if (mode === "transient") return new Response(JSON.stringify({ error: "unavailable" }), { status: 500 });
        const messages = recovered ? [m("a2", "fresh authorized history")] : [m("a1", "private history text")];
        return new Response(JSON.stringify({ messages }), { status: 200 });
      }));
      render(wrap(<ChatView address="0xabc" />));
      expect(await screen.findByText("private history text")).toBeTruthy();
      mode = "denied";
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect((await screen.findByRole("alert")).textContent).toMatch(/owner of this Safe on every network/);
      expect(screen.queryByText("private history text")).toBeNull();
      expect(screen.queryByPlaceholderText("Ask anything, or say how much you need")).toBeNull();
      expect(screen.queryByRole("log")).toBeNull();

      mode = "transient";
      fireEvent.click(screen.getByRole("button", { name: "Check access again" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/owner of this Safe on every network/));
      expect(screen.queryByText("private history text")).toBeNull();
      expect(screen.getByRole("button", { name: "Check access again" })).toBeTruthy();

      mode = "allowed";
      recovered = true;
      fireEvent.click(screen.getByRole("button", { name: "Check access again" }));
      expect(await screen.findByText("fresh authorized history")).toBeTruthy();
      expect(screen.queryByText("private history text")).toBeNull();
    });

    it("shows a server message appended while idle exactly once, and announces it", async () => {
      let stored = [m("a1", "hello")];
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messages: stored }), { status: 200 })));
      render(wrap(<ChatView address="0xabc" />));
      await screen.findByText("hello");
      stored = [m("a1", "hello"), m("d1", "You received 1 ETH")];
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(await screen.findAllByText("You received 1 ETH")).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getAllByText("You received 1 ETH")).toHaveLength(1);
      expect(screen.getByText(/^New message from Lender agent/).closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    });

    it("does not poll while the tab is hidden, and refetches on focus", async () => {
      thread([m("a1", "hello")]);
      render(wrap(<ChatView address="0xabc" />));
      await screen.findByText("hello");
      setVisibility("hidden");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      const before = calls();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(calls()).toBe(before);
      setVisibility("visible");
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(calls()).toBe(before + 1);
    });

    it("does not poll while a reply is streaming", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
        if (init?.method === "POST") { await gate; return new Response("", { status: 200 }); }
        return new Response(JSON.stringify({ messages: [m("a1", "hello")] }), { status: 200 });
      }));
      render(wrap(<ChatView address="0xabc" />));
      await screen.findByText("hello");
      fireEvent.change(screen.getByPlaceholderText("Ask anything, or say how much you need"), { target: { value: "hi" } });
      fireEvent.submit(screen.getByPlaceholderText("Ask anything, or say how much you need").closest("form")!);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const before = calls();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(calls()).toBe(before);
      release();
    });

    it("keeps polling after a failed request (status error)", async () => {
      let stored = [m("a1", "hello")];
      vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
        if (init?.method === "POST") return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ messages: stored }), { status: 200 });
      }));
      render(wrap(<ChatView address="0xabc" />));
      await screen.findByText("hello");
      const box = screen.getByPlaceholderText("Ask anything, or say how much you need");
      fireEvent.change(box, { target: { value: "hi" } });
      fireEvent.submit(box.closest("form")!);
      await screen.findByText(/could not answer just now/);
      stored = [m("a1", "hello"), m("d1", "You received 1 ETH")];
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(await screen.findAllByText("You received 1 ETH")).toHaveLength(1);
    });
  });
});
