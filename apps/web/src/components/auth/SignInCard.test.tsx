// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { SignInCard } from "./SignInCard";

let connected = false;
let session: { address: string } | null = null;
let sessionLoading = false;
type C = { id: string; name: string; type?: string; icon?: string };
let connectorList: C[] = [{ id: "injected", name: "Injected" }];
const connect = vi.fn();
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: connected ? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" : undefined, isConnected: connected }),
  useConnect: () => ({ connect, connectors: connectorList, isPending: false, error: null }),
}));
const signIn = vi.fn(() => Promise.resolve({ address: "0x1" }));
let signInError: Error | null = null;
vi.mock("@/client/auth/useSession", () => ({ useSession: () => ({ session, loading: sessionLoading, signIn, signingIn: false, signInError }) }));

afterEach(() => {
  cleanup();
  connectorList = [{ id: "injected", name: "Injected" }];
  connected = false;
  session = null;
  sessionLoading = false;
  connect.mockClear();
  signIn.mockClear();
  signInError = null;
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.unstubAllEnvs();
});
const coinbase: C = { id: "baseAccount", name: "Base Account", type: "baseAccount" };
const rabby: C = { id: "io.rabby", name: "Rabby Wallet", type: "injected", icon: "data:image/svg+xml;base64,AAA" };
const HINT = "You need a crypto wallet app. Signing in is free and sends nothing.";

describe("SignInCard", () => {
  it("tells a first-timer what they need before they click the sign-in button", () => {
    connected = false;
    connectorList = [coinbase];
    render(<SignInCard />);
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sign in with wallet/ })).toBeTruthy();
  });
  it("drops the hint once the wallet is connected", () => {
    connected = true;
    render(<SignInCard />);
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.getByText("Signing proves you own this wallet. No transaction is sent.")).toBeTruthy();
  });
  it("says the page they opened comes back when returning", () => {
    connected = false;
    render(<SignInCard returning />);
    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
    expect(screen.getByText("You will go back to the page you opened.")).toBeTruthy();
  });
  it("keeps the default heading otherwise", () => {
    connected = false;
    render(<SignInCard />);
    expect(screen.getByRole("heading", { name: "Borrow cash against your crypto" })).toBeTruthy();
  });
  it("keeps Connect wallet as the first action without a detected wallet and checks again on click", () => {
    connected = false;
    connectorList = [];
    render(<SignInCard presentation="hero" />);
    const button = screen.getByRole("button", { name: "Connect wallet" });
    expect(screen.getByText(/No wallet found in this browser/)).toBeTruthy();
    fireEvent.click(button);
    expect(screen.getByRole("status").textContent).toMatch(/reload this page so the browser can detect it/);
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });
  it("connects a supported wallet directly from the hero action", () => {
    connected = false;
    connectorList = [coinbase];
    render(<SignInCard presentation="hero" />);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(connect).toHaveBeenCalledWith({ connector: coinbase });
  });
  it.each(["without an extension", "without replacing an existing extension"])("connects the dedicated local-demo wallet with one hero click %s", (_case) => {
    const localDemo: C = { id: "local-demo", name: "Local demo wallet", type: "injected" };
    const extension = { isDevWallet: false };
    connectorList = [localDemo];
    vi.stubEnv("NEXT_PUBLIC_MOCK_WALLET", "1");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    if (_case.includes("existing")) (window as unknown as { ethereum?: unknown }).ethereum = extension;
    render(<SignInCard presentation="hero" />);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(connect).toHaveBeenCalledWith({ connector: localDemo });
    if (_case.includes("existing")) expect((window as unknown as { ethereum?: unknown }).ethereum).toBe(extension);
  });
  it("renders a deterministic checking state and discovers an injected-only wallet after hydration", async () => {
    const generic: C = { id: "injected", name: "Injected", type: "injected" };
    connectorList = [generic];
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SignInCard presentation="hero" />);
    expect(container.textContent).toContain("Checking wallet…");
    document.body.appendChild(container);
    (window as unknown as { ethereum: unknown }).ethereum = {};
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, <SignInCard presentation="hero" />, { onRecoverableError });
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
      expect(connect).toHaveBeenCalledWith({ connector: generic });
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
  it("does not connect or request a signature while the session lookup is pending", () => {
    connected = true;
    sessionLoading = true;
    connectorList = [coinbase];
    render(<SignInCard presentation="hero" />);
    const button = screen.getByRole("button", { name: "Checking session…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(connect).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });
  it("does not request a second signature when an authenticated session is already available", () => {
    connected = true;
    session = { address: "0x1" };
    render(<SignInCard presentation="hero" />);
    const button = screen.getByRole("button", { name: "Opening your app…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(connect).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });
  it("explains a missing wallet, links to a guide and offers a way to check again", () => {
    connected = false;
    connectorList = [];
    render(<SignInCard />);
    const note = screen.getByText(/No wallet found in this browser\. A wallet is an app or browser extension that holds your crypto\./);
    const button = screen.getByRole("button", { name: "Check again" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBe(note.id);
    const link = screen.getByRole("link", { name: /How to choose a wallet/ });
    expect(link.getAttribute("href")).toBe("https://ethereum.org/wallets/find-wallet/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("gives a reload step when Check again still cannot find a newly installed wallet", () => {
    connected = false;
    connectorList = [];
    render(<SignInCard />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(screen.getByRole("status").textContent).toMatch(/If you just installed one, reload this page/);
    expect(connect).not.toHaveBeenCalled();
  });
  it("a configured connector with nothing to offer counts as no wallet: guide plus Check again, and a wallet installed later connects", () => {
    connected = false;
    // `injected()` is always configured, so connectors.length is 1 even when no wallet can be used.
    const generic: C = { id: "injected", name: "Injected", type: "injected" };
    connectorList = [generic];
    render(<SignInCard />);
    expect(screen.getByText(/No wallet found in this browser/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Choose a wallet" })).toBeNull();
    (window as unknown as { ethereum: unknown }).ethereum = {};
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(connect).toHaveBeenCalledWith({ connector: generic });
  });
  it("says the borrowed money arrives in the Safe as digital dollars, separate from a bank", () => {
    connected = false;
    render(<SignInCard />);
    expect(screen.getByText(/arrives in your Safe as USDC/)).toBeTruthy();
    expect(screen.getByText(/bank/)).toBeTruthy();
  });
  it("a returning sign-in does not explain the destination again", () => {
    connected = false;
    render(<SignInCard returning />);
    expect(screen.queryByText(/USDC|digital dollar/)).toBeNull();
  });
  it("opens a chooser with detected wallets and Coinbase Wallet, and one click connects", () => {
    connected = false;
    connectorList = [{ id: "injected", name: "Injected", type: "injected" }, rabby, coinbase];
    render(<SignInCard />);
    expect(screen.queryByRole("button", { name: "Rabby Wallet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with wallet/ }));
    expect(screen.getByRole("button", { name: "Rabby Wallet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Injected|Browser wallet/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Coinbase Wallet" }));
    expect(connect).toHaveBeenCalledWith({ connector: coinbase });
  });
  it("offers the generic browser wallet only when window.ethereum exists and nothing was announced", () => {
    connected = false;
    const generic: C = { id: "injected", name: "Injected", type: "injected" };
    connectorList = [generic, coinbase];
    (window as unknown as { ethereum: unknown }).ethereum = {};
    render(<SignInCard />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in with wallet/ }));
    fireEvent.click(screen.getByRole("button", { name: "Browser wallet" }));
    expect(connect).toHaveBeenCalledWith({ connector: generic });
  });
  it("without a browser wallet, Coinbase Wallet is the only choice and connects directly", () => {
    connected = false;
    connectorList = [{ id: "injected", name: "Injected", type: "injected" }, coinbase];
    render(<SignInCard />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in with wallet/ }));
    expect(connect).toHaveBeenCalledWith({ connector: coinbase });
  });
  it("the mock dev wallet connects straight away", () => {
    connected = false;
    vi.stubEnv("NEXT_PUBLIC_MOCK_WALLET", "1");
    const generic: C = { id: "injected", name: "Injected", type: "injected" };
    connectorList = [generic, coinbase];
    render(<SignInCard />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in with wallet/ }));
    expect(connect).toHaveBeenCalledWith({ connector: generic });
  });
  it("when already connected, the one button just signs", () => {
    connected = true;
    render(<SignInCard />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in with wallet/ }));
    expect(connect).not.toHaveBeenCalled();
    expect(signIn).toHaveBeenCalledTimes(1);
  });
  it("connects first, then requests the signature without a second click", () => {
    connected = false;
    vi.stubEnv("NEXT_PUBLIC_MOCK_WALLET", "1");
    const { rerender } = render(<SignInCard />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in with wallet/ }));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(signIn).not.toHaveBeenCalled();
    connected = true;
    rerender(<SignInCard />);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Sign in$/ })).toBeNull();
  });
  it("after a rejected signature, shows the error and the same button to retry", () => {
    connected = true;
    signInError = new Error("User rejected the request");
    render(<SignInCard />);
    expect(screen.getByRole("alert").textContent).toContain("User rejected");
    fireEvent.click(screen.getByRole("button", { name: /Sign in with wallet/ }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });
});
