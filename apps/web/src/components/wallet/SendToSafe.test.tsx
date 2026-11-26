// @vitest-environment jsdom
import { createContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parseEther, parseUnits } from "viem";

const SAFE = "0x1111111111111111111111111111111111111111";
const WST = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const state = { connected: true, chainId: 8453, ethBalance: parseEther("1"), wstBalance: parseEther("2") };
const sendTransactionAsync = vi.fn();
const writeContractAsync = vi.fn();
const switchChainAsync = vi.fn();
const waitForTransactionReceipt = vi.fn();
const client = { waitForTransactionReceipt };
const walletHooks = vi.hoisted(() => ({ balance: vi.fn(), contracts: vi.fn(), send: vi.fn(), write: vi.fn(), switchChain: vi.fn() }));
vi.mock("wagmi", () => ({
  WagmiContext: createContext({}),
  useAccount: () => ({ address: state.connected ? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" : undefined, isConnected: state.connected, chainId: state.chainId }),
  useBalance: (...args: unknown[]) => walletHooks.balance(...args),
  useReadContracts: (...args: unknown[]) => walletHooks.contracts(...args),
  useSendTransaction: (...args: unknown[]) => walletHooks.send(...args),
  useWriteContract: (...args: unknown[]) => walletHooks.write(...args),
  useSwitchChain: (...args: unknown[]) => walletHooks.switchChain(...args),
  usePublicClient: () => client,
}));

import { SendToSafe } from "./SendToSafe";
import { TxToastProvider } from "./TxToasts";

beforeEach(() => {
  Object.assign(state, { connected: true, chainId: 8453, ethBalance: parseEther("1"), wstBalance: parseEther("2") });
  sendTransactionAsync.mockReset().mockResolvedValue("0xabc");
  writeContractAsync.mockReset().mockResolvedValue("0xdef");
  switchChainAsync.mockReset().mockResolvedValue({});
  waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success" });
  walletHooks.balance.mockReset().mockImplementation(() => ({ data: { value: state.ethBalance } }));
  walletHooks.contracts.mockReset().mockImplementation(() => ({ data: [{ status: "success", result: state.wstBalance }] }));
  walletHooks.send.mockReset().mockReturnValue({ sendTransactionAsync });
  walletHooks.write.mockReset().mockReturnValue({ writeContractAsync });
  walletHooks.switchChain.mockReset().mockReturnValue({ switchChainAsync });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

const amount = () => screen.getByLabelText("Amount") as HTMLInputElement;
const type = (v: string) => fireEvent.change(amount(), { target: { value: v } });
const send = () => screen.getByRole("button", { name: /Send to Safe/ }) as HTMLButtonElement;

describe("SendToSafe", () => {
  it("shows the funded demo notice without mounting balance, send, or chain-switch hooks", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    expect(screen.getByRole("note").textContent).toMatch(/Demo Safe is already funded.*Sending from a wallet is unavailable/);
    expect(screen.queryByLabelText("Amount")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(walletHooks.balance).not.toHaveBeenCalled();
    expect(walletHooks.contracts).not.toHaveBeenCalled();
    expect(walletHooks.send).not.toHaveBeenCalled();
    expect(walletHooks.write).not.toHaveBeenCalled();
    expect(walletHooks.switchChain).not.toHaveBeenCalled();
  });
  it("shows the wallet's balances for the card's assets", () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} assets={["ETH", "wstETH"]} />);
    expect(screen.getByText(/1 ETH/)).toBeTruthy();
    expect(screen.getByText(/2 wstETH/)).toBeTruthy();
  });
  it("Max keeps 0.0005 ETH for gas and says so", () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(amount().value).toBe("0.9995");
    expect(screen.getByText(/0\.0005 ETH.*network fee/)).toBeTruthy();
  });
  it("sends ETH to the Safe with the typed value", async () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    type("0.25");
    fireEvent.click(send());
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledWith({ to: SAFE, value: parseEther("0.25"), chainId: 8453 }));
    expect(await screen.findByText(/in about a minute/)).toBeTruthy();
    expect((screen.getByRole("link", { name: /View on Basescan/ }) as HTMLAnchorElement).href).toBe("https://basescan.org/tx/0xabc");
    expect(writeContractAsync).not.toHaveBeenCalled();
  });
  it("sends wstETH with transfer(safe, amount)", async () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    fireEvent.change(screen.getByLabelText("Asset"), { target: { value: "wstETH" } });
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(amount().value).toBe("2");
    fireEvent.click(send());
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalled());
    const call = writeContractAsync.mock.calls[0][0];
    expect(call).toMatchObject({ address: WST, functionName: "transfer", args: [SAFE, parseEther("2")], chainId: 8453 });
    expect(sendTransactionAsync).not.toHaveBeenCalled();
  });
  it("can send USDC directly to the Safe for same-network repayment", async () => {
    state.wstBalance = parseUnits("12.5", 6);
    render(<SendToSafe chainIds={[8453]} safe={SAFE} assets={["USDC"]} />);
    expect(screen.getByText(/12\.5 USDC/)).toBeTruthy();
    type("5");
    fireEvent.click(send());
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalled());
    expect(writeContractAsync.mock.calls[0][0]).toMatchObject({ address: USDC, functionName: "transfer", args: [SAFE, parseUnits("5", 6)], chainId: 8453 });
    expect(sendTransactionAsync).not.toHaveBeenCalled();
  });
  it("switches to Base first when the wallet is on another network", async () => {
    state.chainId = 1;
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    type("0.1");
    fireEvent.click(send());
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalled());
    expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 8453 });
    expect(switchChainAsync.mock.invocationCallOrder[0]).toBeLessThan(sendTransactionAsync.mock.invocationCallOrder[0]);
  });
  it("does not send when switching network is refused", async () => {
    state.chainId = 1;
    switchChainAsync.mockRejectedValue(Object.assign(new Error("x"), { code: 4001 }));
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    type("0.1");
    fireEvent.click(send());
    expect(await screen.findByText("You cancelled in your wallet.")).toBeTruthy();
    expect(sendTransactionAsync).not.toHaveBeenCalled();
  });
  it("says so when the wallet rejects", async () => {
    sendTransactionAsync.mockRejectedValue(Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" }));
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    type("0.1");
    fireEvent.click(send());
    expect(await screen.findByText("You cancelled in your wallet.")).toBeTruthy();
  });
  it("disables sending with a reason when the amount is more than the balance", () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    type("5");
    expect(send().disabled).toBe(true);
    expect(screen.getByText(/You only have 1 ETH/)).toBeTruthy();
  });
  it("disables sending with a reason when there is nothing to send", () => {
    state.ethBalance = 0n;
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    expect(send().disabled).toBe(true);
    expect(screen.getByText(/no ETH on Base/)).toBeTruthy();
  });
  it("is disabled for a zero or empty amount", () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    expect(send().disabled).toBe(true);
    type("0");
    expect(send().disabled).toBe(true);
  });
  it("offers no destination field: the Safe is the only recipient", async () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    expect(screen.queryByRole("textbox", { name: /address|to$/i })).toBeNull();
    expect(screen.getByText(/Sends to your Safe/)).toBeTruthy();
    expect(screen.getByTestId("send-to").textContent).toMatch(/^To:.*\(your Safe, /);
  });
  it("asks to connect when no wallet is connected", () => {
    state.connected = false;
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(screen.getByText(/Connect your wallet/)).toBeTruthy();
  });
  const sendOnce = async () => {
    render(<SendToSafe chainIds={[8453]} safe={SAFE} />);
    type("0.1");
    fireEvent.click(send());
  };
  it("a reverted transfer says it failed, not Sent", async () => {
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await sendOnce();
    expect(await screen.findByText("The transfer failed on the network. Nothing left your wallet except the network fee.")).toBeTruthy();
    expect(screen.queryByText(/^Sent/)).toBeNull();
  });
  it("says Sent while waiting, and Sent with the explorer link once it lands", async () => {
    let done!: (v: unknown) => void;
    waitForTransactionReceipt.mockReturnValue(new Promise((r) => { done = r; }));
    await sendOnce();
    expect(await screen.findByText(/Sent\. Waiting for the network/)).toBeTruthy();
    done({ status: "success" });
    expect(await screen.findByText("Sent. It will show in your Safe in about a minute.")).toBeTruthy();
    expect((screen.getByRole("link", { name: /View on Basescan/ }) as HTMLAnchorElement).href).toBe("https://basescan.org/tx/0xabc");
  });
  it("a cancel replacement says you cancelled, even though the cancel itself succeeds", async () => {
    waitForTransactionReceipt.mockImplementation(async ({ onReplaced }: { onReplaced: (r: unknown) => void }) => {
      onReplaced({ reason: "cancelled", transaction: { hash: "0xcancel" } });
      return { status: "success" };
    });
    await sendOnce();
    expect(await screen.findByText("You cancelled this transfer in your wallet.")).toBeTruthy();
    expect(screen.queryByText(/It will show in your Safe/)).toBeNull();
  });
  it("a replacement with different contents is not success", async () => {
    waitForTransactionReceipt.mockImplementation(async ({ onReplaced }: { onReplaced: (r: unknown) => void }) => {
      onReplaced({ reason: "replaced", transaction: { hash: "0xother" } });
      return { status: "success" };
    });
    await sendOnce();
    expect(await screen.findByText("This transfer was replaced by a different transaction in your wallet. Check your wallet.")).toBeTruthy();
    expect(screen.queryByText(/It will show in your Safe/)).toBeNull();
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it("retries the receipt wait, then points to the explorer instead of spinning forever", async () => {
    waitForTransactionReceipt.mockRejectedValue(new Error("timed out"));
    await sendOnce();
    expect(await screen.findByText("Still waiting for the network. Check the transfer on Basescan.")).toBeTruthy();
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(3);
    expect((screen.getByRole("link", { name: /View on Basescan/ }) as HTMLAnchorElement).href).toBe("https://basescan.org/tx/0xabc");
  });
  it("a receipt wait that times out once and then lands is a success", async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(new Error("timed out")).mockResolvedValue({ status: "success" });
    await sendOnce();
    expect(await screen.findByText("Sent. It will show in your Safe in about a minute.")).toBeTruthy();
  });
  it("a speed-up follows the new hash", async () => {
    waitForTransactionReceipt.mockImplementation(async ({ hash, onReplaced }: { hash: string; onReplaced: (r: unknown) => void }) => {
      if (hash === "0xabc") { onReplaced({ reason: "repriced", transaction: { hash: "0xfaster" } }); return new Promise(() => {}); }
      return { status: "success" };
    });
    await sendOnce();
    await waitFor(() => expect((screen.getByRole("link", { name: /View on Basescan/ }) as HTMLAnchorElement).href).toBe("https://basescan.org/tx/0xfaster"));
    expect(await screen.findByText("Sent. It will show in your Safe in about a minute.")).toBeTruthy();
    expect(waitForTransactionReceipt.mock.calls.map((c) => c[0].hash)).toEqual(["0xabc", "0xfaster"]);
  });
  it("offers nothing when the Safe is not owned on a network with a known asset list", () => {
    render(<SendToSafe chainIds={[]} safe={SAFE} />);
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
  });
  it("sends on Arbitrum only, with Arbitrum's token and chain, when the Safe is owned only there", async () => {
    state.chainId = 42161;
    render(<SendToSafe chainIds={[42161]} safe={SAFE} />);
    expect(screen.getByText(/on Arbitrum/)).toBeTruthy();
    expect(screen.queryByLabelText("Network")).toBeNull();
    fireEvent.change(screen.getByLabelText("Asset"), { target: { value: "wstETH" } });
    type("1");
    fireEvent.click(send());
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalled());
    expect(writeContractAsync.mock.calls[0][0]).toMatchObject({ address: "0x5979D7b546E38E414F7E9822514be443A4800529", chainId: 42161 });
    expect((await screen.findByRole("link", { name: /View on Arbiscan/ }) as HTMLAnchorElement).href).toBe("https://arbiscan.io/tx/0xdef");
  });
  it("lets the user pick a network when the Safe is owned on both", () => {
    render(<SendToSafe chainIds={[42161, 8453]} safe={SAFE} />);
    expect((screen.getByLabelText("Network") as HTMLSelectElement).value).toBe("8453");
  });
  it("shows a toast alongside the inline notice, and both end on the same outcome", async () => {
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    render(<TxToastProvider><SendToSafe chainIds={[8453]} safe={SAFE} /></TxToastProvider>);
    type("0.005");
    fireEvent.click(send());
    expect(await screen.findAllByText(/The transfer failed on the network/)).toHaveLength(2);
  });
  it("toasts the amount while sending", async () => {
    waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    render(<TxToastProvider><SendToSafe chainIds={[8453]} safe={SAFE} /></TxToastProvider>);
    type("0.005");
    fireEvent.click(send());
    expect(await screen.findByText("Sending 0.005 ETH to your Safe")).toBeTruthy();
  });
  it("toasts a refused wallet prompt as cancelled", async () => {
    sendTransactionAsync.mockRejectedValue(Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" }));
    render(<TxToastProvider><SendToSafe chainIds={[8453]} safe={SAFE} /></TxToastProvider>);
    type("0.1");
    fireEvent.click(send());
    expect(await screen.findAllByText("You cancelled in your wallet.")).toHaveLength(2);
  });
});
