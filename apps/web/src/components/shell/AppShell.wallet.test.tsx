// @vitest-environment jsdom
import { createContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Safe } from "@/lib/types";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
vi.mock("next/navigation", () => ({ usePathname: () => "/s/0xabc", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("wagmi", () => ({
  WagmiContext: createContext({}),
  useAccount: () => ({ address: WALLET, isConnected: true, chainId: 8453 }),
  useBalance: () => ({ data: { value: 0n } }),
  useReadContracts: () => ({ data: [{ status: "success", result: 0n }] }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false }),
}));
import { AppShell } from "./AppShell";
import { ShellProvider } from "./ShellContext";

const safe: Safe = { id: "s1", name: "Treasury", address: "0xabc", threshold: "2/3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };
const open = (userAddress: string) => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollTo = () => {};
  render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><AppShell userLabel="0x7099…79C8" userAddress={userAddress}><h1>x</h1></AppShell></ShellProvider>);
  fireEvent.click(screen.getByRole("button", { name: /Your wallet/ }));
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AppShell wallet popover", () => {
  it("warns when the connected wallet is not the signed-in address", () => {
    open("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    expect(screen.getByRole("note").textContent).toMatch(/not the wallet you signed in with/);
  });
  it("is quiet when they match, whatever the letter case", () => {
    open(WALLET.toLowerCase());
    expect(screen.queryByRole("note")).toBeNull();
  });
});
