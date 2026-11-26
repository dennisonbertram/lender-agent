// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Safe } from "@/lib/types";
import { ShellProvider } from "@/components/shell/ShellContext";
import { ActivityLog } from "./ActivityLog";

const ADDR = "0x5afe00000000000000000000000000000000f001";
const safe: Safe = { id: "s1", name: "Treasury", address: ADDR, threshold: "2/3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };
const now = Date.now();

function show(activity: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ activity })));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><ActivityLog /></ShellProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ActivityLog", () => {
  it("renders rows with actor pill, detail and time", async () => {
    show([
      { id: 2, at: now - 5 * 60_000, actor: "Agent (reserve)", kind: "reserve", text: "Used $500", detail: "Supplied 1 ETH", timeLabel: "" },
      { id: 1, at: now - 2 * 60_000, actor: "You", kind: "signed", text: "Signed: Repay", detail: null, timeLabel: "" },
    ]);
    expect(await screen.findByText("Used $500")).toBeTruthy();
    expect(screen.getAllByText("Agent (reserve)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("You").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Supplied 1 ETH").length).toBe(1);
    expect(screen.getAllByText("5 min ago").length).toBeGreaterThan(0);
  });
  it("links a tx hash to the explorer, else falls back to In Safe", async () => {
    const tx = `0x${"ab".repeat(30)}ef90`, stx = `0x${"cd".repeat(32)}`;
    show([
      { id: 2, at: now, actor: "Agent", kind: "status", text: "Executed", detail: null, timeLabel: "", chainId: 8453, proposalId: "p1", txHash: tx, safeTxHash: stx },
      { id: 1, at: now, actor: "Agent", kind: "status", text: "Queued", detail: null, timeLabel: "", chainId: 8453, proposalId: "p2", txHash: null, safeTxHash: stx },
    ]);
    await screen.findByText("Executed");
    expect(screen.getByText("Tx")).toBeTruthy();
    expect(screen.getByText("0xabab…ef90")).toBeTruthy();
    expect((screen.getByLabelText("View transaction on Basescan") as HTMLAnchorElement).href).toBe(`https://basescan.org/tx/${tx}`);
    const inSafe = screen.getAllByRole("link", { name: /In Safe/ });
    expect(inSafe).toHaveLength(1);
    expect(inSafe[0].getAttribute("href")).toContain("app.safe.global");
    expect(screen.getAllByText("View proposal")).toHaveLength(2);
  });
  it("shows the empty state", async () => {
    show([]);
    expect(await screen.findByText("Nothing has happened in this Safe yet. Agent checks, proposals and signatures will show up here.")).toBeTruthy();
  });

  it("a failed read shows a titled error with a way out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "boom" }, { status: 500 })));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><ActivityLog /></ShellProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Something went wrong on our side" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps the Co-signer actor pill on one line", async () => {
    show([{ id: 3, at: now - 60_000, actor: "Co-signer (Sam)", kind: "signed", text: "Co-signer signed", detail: null, timeLabel: "" }]);
    await screen.findByText("Co-signer signed");
    for (const pill of screen.getAllByText("Co-signer (Sam)")) expect(pill.className).toContain("whitespace-nowrap");
  });

  it("shows the Safe address with network, copy and explorer under the title", async () => {
    show([]);
    await screen.findByText("Nothing has happened in this Safe yet. Agent checks, proposals and signatures will show up here.");
    const id = screen.getByTestId("safe-identity");
    expect(id.textContent).toContain("Base");
    expect(id.querySelector("[title]")?.getAttribute("title")?.toLowerCase()).toBe(ADDR);
    expect(within(id).getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(within(id).getByRole("link", { name: "View on Basescan" })).toBeTruthy();
  });

  it("links a row to its proposal, its transaction and its Safe transaction", async () => {
    const tx = `0x${"cd".repeat(32)}`;
    const safeTx = `0x${"ab".repeat(32)}`;
    show([
      { id: 3, at: now, actor: "Agent", kind: "proposed", text: "Sent it", detail: null, timeLabel: "", chainId: 8453, proposalId: "p-9", safeTxHash: null, txHash: null },
      { id: 2, at: now, actor: "Agent", kind: "status", text: "Arrived", detail: `Destination transaction ${tx}.`, timeLabel: "", chainId: 8453, proposalId: null, safeTxHash: null, txHash: tx },
      { id: 1, at: now, actor: "Co-signer 0x7099…79c8", kind: "signed", text: "Signed: Repay", detail: null, timeLabel: "", chainId: 8453, proposalId: null, safeTxHash: safeTx, txHash: null },
    ]);
    await screen.findByText("Sent it");
    expect(screen.getByRole("link", { name: "View proposal" }).getAttribute("href")).toBe(`/s/${ADDR}/proposals/p-9`);
    expect(screen.getByRole("link", { name: "View transaction on Basescan" }).getAttribute("href")).toBe(`https://basescan.org/tx/${tx}`);
    expect(screen.getAllByRole("link", { name: /In Safe/ }).some((a) => a.getAttribute("href")?.includes(safeTx))).toBe(true);
  });

  it("links a Reserve setup to the Reserve Safe, not this Safe, and has no proposal page link", async () => {
    const safeTx = `0x${"ab".repeat(32)}`;
    const RESERVE = "0x5aFE3855358E112B5647B952709E6165e1c1eEEe";
    show([{ id: 1, at: now, actor: "You", kind: "proposed", text: "Reserve setup drafted", detail: null, timeLabel: "", chainId: 8453, proposalId: "rp", safeTxHash: safeTx, txHash: null, proposalSafe: RESERVE }]);
    await screen.findByText("Reserve setup drafted");
    expect(screen.queryByRole("link", { name: "View proposal" })).toBeNull();
    const href = screen.getByRole("link", { name: /In Safe/ }).getAttribute("href")!;
    expect(href).toContain(RESERVE);
    expect(href).not.toContain(ADDR);
  });
  it("opens the explorer of the chain the hash belongs to, and none when it is unknown", async () => {
    const tx = `0x${"cd".repeat(32)}`;
    show([
      { id: 2, at: now, actor: "Agent", kind: "status", text: "Arrived", detail: null, timeLabel: "", chainId: 8453, proposalId: null, safeTxHash: null, txHash: tx, txChainId: 42161 },
      { id: 1, at: now, actor: "Agent", kind: "status", text: "Arrived old", detail: null, timeLabel: "", chainId: 8453, proposalId: null, safeTxHash: null, txHash: tx, txChainId: null },
    ]);
    await screen.findByText("Arrived");
    const links = screen.getAllByRole("link", { name: /View transaction on/ });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(`https://arbiscan.io/tx/${tx}`);
  });
  it("marks arrivals by receipt chain, source events by source chain, and hides unknown legacy receipts", async () => {
    const tx = `0x${"cd".repeat(32)}`;
    show([
      { id: 3, at: now, actor: "Agent", kind: "status", text: "Arrived on Arbitrum", detail: null, timeLabel: "", chainId: 8453, proposalId: null, safeTxHash: null, txHash: tx, txChainId: 42161, displayChainId: 42161 },
      { id: 2, at: now, actor: "Agent", kind: "status", text: "Old arrival", detail: `Destination transaction ${tx}.`, timeLabel: "", chainId: 8453, proposalId: null, safeTxHash: null, txHash: null, txChainId: null, displayChainId: null },
      { id: 1, at: now, actor: "Agent", kind: "proposed", text: "Sent from Base", detail: null, timeLabel: "", chainId: 8453, proposalId: null, safeTxHash: null, txHash: null, txChainId: null, displayChainId: 8453 },
    ]);
    const arrival = await screen.findByText("Arrived on Arbitrum");
    const arrivalRow = arrival.closest("tr")!;
    expect(arrivalRow.querySelector('img[src="/network-marks/arbitrum-one.svg"]')).toBeTruthy();
    expect(arrivalRow.querySelector('img[src="/network-marks/base.svg"]')).toBeNull();
    const sourceRow = screen.getByText("Sent from Base").closest("tr")!;
    expect(sourceRow.querySelector('img[src="/network-marks/base.svg"]')).toBeTruthy();
    expect(sourceRow.querySelector('img[src="/network-marks/arbitrum-one.svg"]')).toBeNull();
    const oldArrivalRow = screen.getByText("Old arrival").closest("tr")!;
    expect(oldArrivalRow.querySelector('img[src^="/network-marks/"]')).toBeNull();
  });
});
