// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Safe } from "@/lib/types";

let pathname = "/s/0xabc";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push: vi.fn() }) }));

import { AppShell } from "./AppShell";
import { ShellProvider, type ShellLoan } from "./ShellContext";

const safe: Safe = { id: "s1", name: "Treasury", address: "0xabc", threshold: "2/3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };
const loan: ShellLoan = { id: "l1", safeId: "s1", network: "base", venue: "Aave v3", collAsset: "ETH", collAmount: 2, debtAsset: "USDC", debt: 3000, lt: 0.8, apr: 3.4, accrued: 0, hf: 1.5, status: "watch" };

const mockMedia = (matching: (q: string) => boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: matching(query), media: query, addEventListener() {}, removeEventListener() {} }));

const shell = (loans: ShellLoan[] = [], chat?: React.ReactNode) => (
  <ShellProvider safe={safe} safes={[safe]} loans={loans} agentOn watching>
    <AppShell chat={chat}><h1>Overview</h1></AppShell>
  </ShellProvider>
);

beforeEach(() => { pathname = "/s/0xabc"; Element.prototype.scrollTo = () => {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AppShell", () => {
  it("shows the sidebar with nav links, the loans and the page on a wide screen", () => {
    mockMedia(() => true);
    render(shell([loan]));
    expect(screen.getByRole("link", { name: /Ask the agent/ }).getAttribute("href")).toBe("/s/0xabc/chat");
    expect(screen.getByRole("link", { name: /Overview/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Activity/ }).getAttribute("href")).toBe("/s/0xabc/activity");
    expect(screen.getByRole("link", { name: /Settings/ }).getAttribute("href")).toBe("/s/0xabc/settings");
    expect(screen.getByText("Loans")).toBeTruthy();
    expect(screen.getByText("Watch 1.50").closest("a")?.getAttribute("href")).toBe("/s/0xabc/loans/l1");
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });
  it("renders a debt-free loan (hf null) without throwing and says No debt", () => {
    mockMedia(() => true);
    render(shell([{ ...loan, hf: null, debt: 0, status: "healthy" }]));
    expect(screen.getByText("No debt").closest("a")?.getAttribute("href")).toBe("/s/0xabc/loans/l1");
  });
  it("hides the sidebar on a phone and shows the menu button and Safe picker", () => {
    mockMedia(() => false);
    render(shell());
    expect(screen.queryByRole("link", { name: /Ask the agent/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch Safe, current: Treasury" })).toBeTruthy();
  });
  it("docks the chat slot at 1100px and wider, and offers a button below", () => {
    mockMedia(() => true);
    const { unmount } = render(shell([], <p>chat panel</p>));
    expect(screen.getByText("chat panel")).toBeTruthy();
    unmount();
    mockMedia((q) => q.includes("768"));
    render(shell([], <p>chat panel</p>));
    expect(screen.queryByText("chat panel")).toBeNull();
    expect(screen.getByRole("button", { name: /Lender agent|agent/i })).toBeTruthy();
  });
  it("does not dock the chat on the chat page", () => {
    pathname = "/s/0xabc/chat";
    mockMedia(() => true);
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><AppShell chat={<p>chat panel</p>}><h1>The chat</h1></AppShell></ShellProvider>);
    expect(screen.queryByText("chat panel")).toBeNull();
    expect(screen.getByRole("link", { name: /Ask the agent/ }).getAttribute("aria-current")).toBe("page");
  });
  it("keeps the ownership notice and chat page in a bounded flex column", () => {
    pathname = "/s/0xabc/chat";
    mockMedia(() => true);
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><AppShell chat={<p>panel</p>}><p role="status">Owners differ</p><div>chat page</div></AppShell></ShellProvider>);
    expect(screen.getByRole("status").parentElement?.className).toMatch(/flex[^\"]*min-h-0[^\"]*flex-col/);
    expect(screen.getByText("chat page")).toBeTruthy();
  });

  it("offers a Skip to content link that targets the main content", () => {
    mockMedia(() => true);
    render(shell());
    const link = screen.getByRole("link", { name: "Skip to content" });
    expect(link.className).toContain("sr-only");
    expect(link.className).toContain("focus-visible:not-sr-only");
    const target = document.getElementById(link.getAttribute("href")!.slice(1));
    expect(target?.tagName).toBe("MAIN");
  });

  it("shows Sign out in the sidebar and calls it", () => {
    mockMedia(() => true);
    const out = vi.fn();
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><AppShell userLabel="0x5afe…0001" onSignOut={out}><h1>x</h1></AppShell></ShellProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(out).toHaveBeenCalled();
  });
  it("on a phone, shows '1 loan needs action' as a link to the loan in the header and no dot in the agent button", () => {
    mockMedia(() => false);
    const risky: ShellLoan = { ...loan, status: "risk", hf: 1.05 };
    render(shell([risky], <div>chat</div>));
    const badge = screen.getByRole("link", { name: /1 loan needs action/ });
    expect(badge.getAttribute("href")).toBe("/s/0xabc/loans/l1");
  });
  it("on a phone, the Menu sheet also has Sign out", async () => {
    mockMedia(() => false);
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><AppShell userLabel="0x5afe…0001" onSignOut={vi.fn()}><h1>x</h1></AppShell></ShellProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(await screen.findByRole("button", { name: /Sign out/ })).toBeTruthy();
  });
  it("marks the loan row active when the path has %3A for the link's ':'", () => {
    mockMedia(() => true);
    const l = { ...loan, id: "aave:base:1" };
    pathname = "/s/0xabc/loans/aave%3Abase%3A1";
    render(shell([l]));
    expect(screen.getByText("Watch 1.50").closest("a")?.getAttribute("aria-current")).toBe("page");
  });
  it("says the loans could not load, not 'no loans', when the read failed", () => {
    mockMedia(() => true);
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} loansError agentOn watching><AppShell><h1>x</h1></AppShell></ShellProvider>);
    expect(screen.getByText("Couldn't load loans — retrying")).toBeTruthy();
  });
  it("fixes the shell to the viewport and lets the sidebar scroll itself", () => {
    mockMedia(() => true);
    const { container } = render(shell([loan]));
    // The shell has its own viewport height, independent of ancestors' percentage heights.
    expect((container.firstElementChild as HTMLElement).className).toMatch(/h-dvh[^"]*overflow-hidden/);
    const aside = container.querySelector("aside") as HTMLElement;
    expect(aside.querySelector("[data-sidebar]")!.className).toContain("overflow-y-auto");
  });
  it("resizes to the visible viewport for a soft keyboard without overriding pinch zoom", async () => {
    mockMedia(() => false);
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number; scale: number };
    Object.assign(viewport, { height: 800, offsetTop: 0, scale: 1 });
    vi.stubGlobal("visualViewport", viewport);
    const { container } = render(
      <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching>
        <AppShell><input aria-label="Message" /></AppShell>
      </ShellProvider>,
    );
    const shellRoot = container.firstElementChild as HTMLElement;

    screen.getByRole("textbox", { name: "Message" }).focus();
    Object.assign(viewport, { height: 420, offsetTop: 12 });
    await act(async () => { viewport.dispatchEvent(new Event("resize")); });
    expect(shellRoot.style.height).toBe("420px");
    expect(shellRoot.style.top).toBe("12px");
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const sheet = document.querySelector('[data-slot="sheet-content"]') as HTMLElement;
    expect(sheet.style.maxHeight).toBe("357px");
    expect(sheet.style.bottom).toBe(`${window.innerHeight - 432}px`);

    Object.assign(viewport, { height: 800, offsetTop: 0, scale: 1.5 });
    await act(async () => { viewport.dispatchEvent(new Event("resize")); });
    expect(shellRoot.style.height).toBe("");
    expect(shellRoot.style.top).toBe("");
    expect(sheet.style.maxHeight).toBe("");
    expect(sheet.style.bottom).toBe("");
  });
  it("shows a persistent test-network strip on Base Sepolia, none on Base", () => {
    mockMedia(() => true);
    const { unmount } = render(<ShellProvider safe={safe} safes={[safe]} loans={[]} chainIds={[84532]} agentOn watching><AppShell><h1>x</h1></AppShell></ShellProvider>);
    expect(screen.getByRole("note").textContent).toBe("Test network: Base Sepolia");
    unmount();
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} chainIds={[8453]} agentOn watching><AppShell><h1>x</h1></AppShell></ShellProvider>);
    expect(screen.queryByText(/Test network/)).toBeNull();
  });
  it("does not label Arbitrum mainnet a test network", () => {
    mockMedia(() => true);
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} chainIds={[42161]} agentOn watching><AppShell><h1>x</h1></AppShell></ShellProvider>);
    expect(screen.queryByText(/Test network/)).toBeNull();
  });
  it("does not repeat the Safe address under the picker; the picker shows it and its menu has copy and explorer", () => {
    mockMedia(() => true);
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} chainIds={[8453]} agentOn watching><AppShell><h1>x</h1></AppShell></ShellProvider>);
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  });
});
