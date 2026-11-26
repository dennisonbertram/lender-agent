// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const waitForTransactionReceipt = vi.fn();
const client = { waitForTransactionReceipt };
vi.mock("wagmi", () => ({ usePublicClient: () => client }));

import { TOAST_DISMISS_MS, TxToastProvider, useTxToasts, type TxToastApi } from "./TxToasts";
import { SEND_CHAINS } from "./tokens";

const BASE = SEND_CHAINS[0];
let api!: TxToastApi;
function Grab() { api = useTxToasts(); return null; }
const mount = () => render(<TxToastProvider><Grab /></TxToastProvider>);
const start = async (hash = "0xabc" as `0x${string}`) => {
  let id = 0;
  await act(async () => { id = api.confirm(); });
  await act(async () => { api.sending(id, { hash, chain: BASE, text: "Sending 0.005 ETH to your Safe" }); });
  return id;
};

beforeEach(() => { waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success" }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("transaction toasts", () => {
  it("is a polite live region", () => {
    mount();
    expect(screen.getByRole("region", { name: "Transactions" }).getAttribute("aria-live")).toBe("polite");
  });
  it("walks confirm → sending with a spinner → sent with an explorer link, then dismisses itself", async () => {
    vi.useFakeTimers();
    let done!: (v: unknown) => void;
    waitForTransactionReceipt.mockReturnValue(new Promise((r) => { done = r; }));
    mount();
    let id = 0;
    await act(async () => { id = api.confirm(); });
    expect(screen.getByText("Confirm in your wallet…")).toBeTruthy();
    await act(async () => { api.sending(id, { hash: "0xabc", chain: BASE, text: "Sending 0.005 ETH to your Safe" }); });
    expect(screen.getByText("Sending 0.005 ETH to your Safe")).toBeTruthy();
    expect(screen.queryByText("Confirm in your wallet…")).toBeNull();
    await act(async () => { done({ status: "success" }); });
    expect((screen.getByRole("link", { name: /View on Basescan/ }) as HTMLAnchorElement).href).toBe("https://basescan.org/tx/0xabc");
    expect(screen.getByText(/^Sent/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(TOAST_DISMISS_MS + 10); });
    expect(screen.queryByText(/^Sent/)).toBeNull();
  });
  it("a revert stays until closed", async () => {
    vi.useFakeTimers();
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    mount();
    await start();
    expect(screen.getByText(/The transfer failed on the network/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(TOAST_DISMISS_MS * 3); });
    expect(screen.getByText(/The transfer failed on the network/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/The transfer failed/)).toBeNull();
  });
  it("a cancel replacement stays until closed", async () => {
    vi.useFakeTimers();
    waitForTransactionReceipt.mockImplementation(async ({ onReplaced }: { onReplaced: (r: unknown) => void }) => { onReplaced({ reason: "cancelled", transaction: { hash: "0xc" } }); return { status: "success" }; });
    mount();
    await start();
    await act(async () => { vi.advanceTimersByTime(TOAST_DISMISS_MS * 3); });
    expect(screen.getByText("You cancelled this transfer in your wallet.")).toBeTruthy();
  });
  it("a refused wallet prompt becomes a cancelled toast that stays", async () => {
    mount();
    let id = 0;
    await act(async () => { id = api.confirm(); });
    await act(async () => { api.fail(id, "You cancelled in your wallet.", true); });
    expect(screen.getByText("You cancelled in your wallet.")).toBeTruthy();
    expect(screen.queryByText("Confirm in your wallet…")).toBeNull();
  });
  it("stacks several toasts and closes each on its own", async () => {
    waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    mount();
    await start("0x1");
    await start("0x2");
    expect(screen.getAllByText("Sending 0.005 ETH to your Safe")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.getAllByText("Sending 0.005 ETH to your Safe")).toHaveLength(1);
  });
  it("is a no-op outside the provider", () => {
    render(<Grab />);
    expect(() => { api.sending(api.confirm(), { hash: "0x1", chain: BASE, text: "x" }); }).not.toThrow();
  });
});
