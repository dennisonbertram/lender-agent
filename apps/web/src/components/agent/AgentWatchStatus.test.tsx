// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ShellProvider, type ShellLoan } from "@/components/shell/ShellContext";
import type { Safe } from "@/lib/types";
import { AgentWatchStatus } from "./AgentWatchStatus";

afterEach(cleanup);
const safe: Safe = { id: "s", name: "S", address: "0xabc", threshold: "", agent: true, networks: [], balances: {} };
const loan: ShellLoan = { id: "l1", safeId: "s", network: "base", venue: "Aave v3", collAsset: "ETH", collAmount: 2, debtAsset: "USDC", debt: 3000, lt: 0.8, apr: 3.4, accrued: 0, hf: 1.5, status: "healthy" };
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (p: { agentOn?: boolean; watching?: boolean; failing?: boolean; starting?: boolean; lastCheckAt?: string | null; loans?: ShellLoan[] }) => (
  <QueryClientProvider client={qc()}><ShellProvider safe={safe} safes={[safe]} loans={p.loans ?? [loan]} agentOn={p.agentOn ?? true} watching={p.watching ?? false} failing={p.failing} starting={p.starting} lastCheckAt={p.lastCheckAt}>
    <AgentWatchStatus />
  </ShellProvider></QueryClientProvider>
);

describe("AgentWatchStatus", () => {
  it("watching: green dot, full line in the title, truncating text", () => {
    render(wrap({ watching: true }));
    const t = screen.getByText("Watching 1 loan");
    expect(t.className).toContain("truncate");
    expect(t.parentElement?.getAttribute("title")).toBe("Watching 1 loan");
    expect(t.parentElement?.querySelector("[aria-hidden]")?.className).toContain("bg-success");
  });
  it("lagging: warning dot and the age", () => {
    render(wrap({ failing: true, lastCheckAt: new Date(Date.now() - 4 * 60_000).toISOString() }));
    const t = screen.getByText("Delayed: last check 4 min ago");
    expect(t.parentElement?.querySelector("[aria-hidden]")?.className).toContain("bg-warning");
  });
  it("no loans and an open proposal: waiting for signatures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ proposals: [{ id: "p1", final: false, specKind: "open" }] }), { status: 200, headers: { "content-type": "application/json" } })));
    render(wrap({ loans: [], watching: true }));
    expect(await screen.findByText("The loan hasn't opened yet. The agent starts watching once it does.")).toBeTruthy();
    vi.unstubAllGlobals();
  });
  it("off: Not watching this Safe", () => {
    render(wrap({ agentOn: false }));
    expect(screen.getByText("Not watching this Safe")).toBeTruthy();
  });
  it("takes state and line props for another Safe's picker row", () => {
    render(<AgentWatchStatus variant="row" state="watching" line="Agent on" />);
    expect(screen.getByText("Agent on")).toBeTruthy();
  });
});
