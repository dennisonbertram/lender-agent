// @vitest-environment jsdom
import { createContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseEther } from "viem";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SAFE = "0x1111111111111111111111111111111111111111";
vi.mock("wagmi", () => ({
  WagmiContext: createContext({}),
  useAccount: () => ({ address: WALLET, isConnected: true, chainId: 8453 }),
  useBalance: () => ({ data: { value: parseEther("1.5") } }),
  useReadContracts: () => ({ data: [{ status: "success", result: parseEther("3") }] }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn() }),
}));

import { WalletMenu } from "./WalletMenu";
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("WalletMenu", () => {
  it("local demo explains the seeded Safe and does not offer a wallet transfer", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    render(<WalletMenu userLabel="0x7099…79C8" userAddress={WALLET} safe={SAFE} ownedChainIds={[8453]} />);
    fireEvent.click(screen.getByRole("button", { name: /Your wallet/ }));
    expect(screen.getByRole("note").textContent).toMatch(/Demo Safe is already funded/);
    expect(screen.getByRole("note").textContent).toMatch(/Sending from a wallet is unavailable/);
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(screen.queryByText(/1\.5 ETH/)).toBeNull();
  });
  it("opens to the wallet address, its balances and the send form for the current Safe", () => {
    render(<WalletMenu userLabel="0x7099…79C8" userAddress={WALLET} safe={SAFE} ownedChainIds={[8453]} />);
    fireEvent.click(screen.getByRole("button", { name: /Your wallet/ }));
    expect(screen.getAllByTitle(WALLET).length).toBeGreaterThan(0); // short checksummed text, full address in the title
    expect(screen.getAllByRole("button", { name: "Copy address" }).length).toBe(2); // the wallet, and the Safe the send form sends to
    expect(screen.getAllByText(/1\.5 ETH/).length).toBe(1);
    expect(screen.getAllByText(/3 wstETH/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Send to Safe/ })).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });
  it("says plainly when the connected wallet is not the signed-in one", () => {
    render(<WalletMenu userLabel="0xAbCd…0001" userAddress="0xAbCd000000000000000000000000000000000001" safe={SAFE} ownedChainIds={[8453]} />);
    fireEvent.click(screen.getByRole("button", { name: /Your wallet/ }));
    expect(screen.getByRole("note").textContent).toMatch(/not the wallet you signed in with/);
  });
  it("keeps Sign out", () => {
    const out = vi.fn();
    render(<WalletMenu userLabel="0x7099…79C8" safe={SAFE} onSignOut={out} />);
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(out).toHaveBeenCalled();
  });
  it("offers no send form when the Safe is only set up on a network we cannot send on, just the address and Copy", () => {
    render(<WalletMenu userLabel="0x7099…79C8" userAddress={WALLET} safe={SAFE} ownedChainIds={[10]} />);
    fireEvent.click(screen.getByRole("button", { name: /Your wallet/ }));
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(document.body.textContent).toMatch(/Send on Optimism from your wallet/);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
  it("does not offer Base when the Safe is owned only on Arbitrum", () => {
    render(<WalletMenu userLabel="0x7099…79C8" userAddress={WALLET} safe={SAFE} ownedChainIds={[42161]} />);
    fireEvent.click(screen.getByRole("button", { name: /Your wallet/ }));
    expect(document.body.textContent).toMatch(/on Arbitrum/);
    expect(screen.queryByText(/connected wallet on Base/)).toBeNull();
  });
  it("offers no send form without server-provided networks", () => {
    render(<WalletMenu userLabel="0x7099…79C8" userAddress={WALLET} safe={SAFE} />);
    fireEvent.click(screen.getByRole("button", { name: /Your wallet/ }));
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
  });
});
