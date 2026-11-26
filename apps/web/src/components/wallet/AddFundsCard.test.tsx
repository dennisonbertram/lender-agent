// @vitest-environment jsdom
import { createContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("wagmi", () => ({
  WagmiContext: createContext({}),
  useAccount: () => ({ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", isConnected: true, chainId: 8453 }),
  useBalance: () => ({ data: { value: 10n ** 18n } }),
  useReadContracts: () => ({ data: [{ status: "success", result: 0n }] }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn() }),
}));
import { AddFundsBody } from "@/components/common";
import { OwnedChainsProvider } from "@/components/wallet/OwnedChains";
afterEach(cleanup);

describe("Add funds card", () => {
  it("offers Send to Safe on Base and keeps the address and Copy as a fallback", () => {
    render(<AddFundsBody address="0x1111111111111111111111111111111111111111" networks={["base"]} assets={["ETH", "wstETH"]} />);
    expect(screen.getByRole("button", { name: /Send to Safe/ })).toBeTruthy();
    expect(screen.getByText("Or send from another wallet or an exchange")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Copy/ }).length).toBeGreaterThan(0);
  });
  it("shows only the address when the card lists no network we can send on", () => {
    render(<AddFundsBody address="0x1111111111111111111111111111111111111111" networks={["optimism"]} />);
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeTruthy();
  });
  it("does not offer Base inside a Safe the user owns only on Arbitrum, even when Base is listed", () => {
    render(<OwnedChainsProvider value={[42161]}><AddFundsBody address="0x1111111111111111111111111111111111111111" networks={["base", "arbitrum"]} /></OwnedChainsProvider>);
    expect(screen.getByText(/on Arbitrum/)).toBeTruthy();
    expect(screen.queryByText(/connected wallet on Base/)).toBeNull();
  });
  it("offers no send form inside a Safe the user owns on no sendable network", () => {
    render(<OwnedChainsProvider value={[]}><AddFundsBody address="0x1111111111111111111111111111111111111111" networks={["base"]} /></OwnedChainsProvider>);
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeTruthy();
  });
});
