// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIBlock } from "@/lib/blocks";
import { createContext } from "react";
import { LiveBlock } from "./LiveBlock";

vi.mock("wagmi", () => ({
  WagmiContext: createContext({}),
  useAccount: () => ({ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", isConnected: true, chainId: 8453 }),
  useBalance: () => ({ data: { value: 10n ** 18n } }),
  useReadContracts: () => ({ data: [{ status: "success", result: 0n }] }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./LivePlanBlock", () => ({ LivePlanBlock: () => <p>plan</p> }));

const stamp = { blockNumber: 9, readAt: Date.UTC(2026, 0, 1, 12, 0) };
const mockFetch = (body: object) => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...stamp, ...body })));
const show = (block: UIBlock, onSend = vi.fn()) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LiveBlock block={block} safeAddress="0xabc" onSend={onSend} /></QueryClientProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("LiveBlock", () => {
  it("addfunds: opens the transfer form when the borrower asks to add funds", async () => {
    mockFetch({ address: "0x1111111111111111111111111111111111111111", networks: ["base"], assets: ["ETH", "wstETH"], text: "Send ETH or wstETH to this address." });
    show({ kind: "addfunds" });
    expect(await screen.findByText("Add funds to this Safe")).toBeTruthy();
    expect((screen.getByText("Add funds to this Safe").closest("details") as HTMLDetailsElement).open).toBe(true);
    expect(await screen.findByRole("button", { name: /Send to Safe/ })).toBeTruthy();
    expect(screen.getByText("0x1111111111111111111111111111111111111111")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Copy/ }).length).toBeGreaterThan(0);
  });
  it("status: renders the sentence and the as-of time", async () => {
    mockFetch({ sentence: "Your loan is fine.", maxCash: 0, loans: [{ id: "l1", venue: "Aave v3", hf: 1.8, status: "healthy", dropPct: 44, mixed: false }] });
    show({ kind: "status" });
    expect(await screen.findByText("Your loan is fine.")).toBeTruthy();
    expect(screen.getByText(/^as of \d\d:\d\d$/)).toBeTruthy();
  });
  it("holdings: borrow-up-to line", async () => {
    mockFetch({ rows: [{ network: "base", asset: "ETH", amount: 2.5, value: 7500, max: 4000 }] });
    const onSend = vi.fn();
    show({ kind: "holdings" }, onSend);
    expect(await screen.findByText(/Borrow up to \$4,000/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan with ETH" }));
    expect(onSend).toHaveBeenCalled();
  });
  it("addfunds: address and Base, no WBTC", async () => {
    mockFetch({ address: "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001", networks: ["base"], assets: ["ETH", "wstETH"], text: "Send ETH or wstETH to this address." });
    show({ kind: "addfunds" });
    expect(await screen.findByText("0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001")).toBeTruthy();
    expect(screen.queryByText(/WBTC/)).toBeNull();
  });
  it("keeps the add-funds form open when the Safe has no spendable assets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(String(url).endsWith("/loans") ? { loans: [], balancesByNetwork: [] } : { ...stamp, address: "0x1111111111111111111111111111111111111111", networks: ["base"], assets: ["ETH"], text: "Send ETH to this Safe." })));
    show({ kind: "addfunds" });
    const summary = await screen.findByText("Add funds to this Safe");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(true);
    expect(await screen.findByRole("button", { name: /Send to Safe/ })).toBeTruthy();
  });
  it("explain: lender sentence and plan chip", async () => {
    mockFetch({ topic: "liquidation", needs: 2, levels: { warn: 1.6, act: 1.35 }, maxCash: 5000, lender: "Aave v3", lenderLine: "Aave v3 can sell only part of your collateral." });
    show({ kind: "explain", topic: "liquidation" });
    expect(await screen.findByText("Aave v3 can sell only part of your collateral.")).toBeTruthy();
  });
  it("suggestions render without fetching", () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const onSend = vi.fn();
    show({ kind: "suggestions", items: ["Hello"] }, onSend);
    fireEvent.click(screen.getByRole("button", { name: "Hello" }));
    expect(onSend).toHaveBeenCalledWith("Hello");
    expect(f).not.toHaveBeenCalled();
  });
  it("compare: rows from the server, and Plan this posts a plan block for that lender", async () => {
    mockFetch({ cash: 10000, asset: "ETH", network: "Arbitrum", source: "arbitrum", unread: [], cheapest: "aave-v3", rows: [
      { venueId: "aave-v3", lender: "Aave v3", feasible: true, apr: 3.4, yearly: 340, dropPct: 37, status: "healthy" },
      { venueId: "spark", lender: "Spark", feasible: false, apr: 3.9, reason: "Can lend up to $6,000 against your ETH." },
    ] });
    const onPostBlock = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LiveBlock block={{ kind: "compare", cash: 10000 }} safeAddress="0xabc" onSend={vi.fn()} onPostBlock={onPostBlock} /></QueryClientProvider>);
    expect(await screen.findByText("About $340 in interest a year")).toBeTruthy();
    expect(screen.getByText("Can lend up to $6,000 against your ETH.")).toBeTruthy();
    expect(screen.getByText(/^as of \d\d:\d\d$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan this with Aave v3" }));
    expect(onPostBlock).toHaveBeenCalledWith({ kind: "plan", cash: 10000, asset: "ETH", network: "arbitrum", venueId: "aave-v3" });
  });
  it("whatif: slider and the loan's health from the steps", async () => {
    mockFetch({ asset: "ETH", price: 3000, cash: 10000, chainId: 8453, network: "base", unread: [], hypothetical: null, loans: [{ id: "l1", lender: "Aave v3", venueId: "aave-v3", chainId: 8453, network: "base", collAsset: "ETH", moves: true, steps: [{ drop: 0, hf: 2, status: "healthy" }, { drop: 5, hf: 1.9, status: "healthy" }] }] });
    show({ kind: "whatif", asset: "ETH" });
    expect(await screen.findByRole("slider")).toBeTruthy();
    expect(screen.getByText("2.00")).toBeTruthy();
  });
});
