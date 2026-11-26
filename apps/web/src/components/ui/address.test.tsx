// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AddressText, TxHashLink } from "./address";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const safe = "0xe4aAb4dfF32aBd99e3DD577C230553503a6AC7B3";
const h = "0x6a5e17bbe42c3c37cb35e9ea6ab6bbf7c4fcccc0bb15ed08e1edd46c291a7573";

describe("AddressText", () => {
  it("shows the short address with the full one as title, and explorer + Safe links", () => {
    render(<AddressText address={safe.toLowerCase()} chainId={8453} showSafeApp />);
    expect(screen.getByTitle(safe).textContent).toBe("0xe4aA…C7B3");
    const ex = screen.getByRole("link", { name: "View on Basescan" });
    expect(ex.getAttribute("href")).toBe(`https://basescan.org/address/${safe}`);
    expect(ex.getAttribute("target")).toBe("_blank");
    expect(ex.getAttribute("rel")).toBe("noopener noreferrer");
    const app = screen.getByRole("link", { name: "Open in Safe" });
    expect(app.getAttribute("href")).toBe(`https://app.safe.global/home?safe=base:${safe}`);
    expect(app.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("shows Copy failed, not Copied, when the clipboard throws", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    render(<AddressText address={safe} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.getByText("Copy failed")).toBeTruthy();
  });
  it("has no links without a known chain, and no Safe link unless asked", () => {
    const { rerender } = render(<AddressText address={safe} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    rerender(<AddressText address={safe} chainId={8453} />);
    expect(screen.queryByRole("link", { name: "Open in Safe" })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
  it("copies the checksummed address and shows Copied for 1.5 s", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AddressText address={safe.toLowerCase()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(writeText).toHaveBeenCalledWith(safe);
    expect(screen.getByText("Copied")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByText("Copied")).toBeNull();
  });
});

describe("TxHashLink", () => {
  it("links the short hash to the explorer", () => {
    render(<TxHashLink chainId={84532} hash={h} />);
    const a = screen.getByRole("link", { name: "View transaction on Basescan" });
    expect(a.getAttribute("href")).toBe(`https://sepolia.basescan.org/tx/${h}`);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("0x6a5e…7573")).toBeTruthy();
  });
  it("is plain text without an explorer", () => {
    render(<TxHashLink chainId={5} hash={h} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("0x6a5e…7573")).toBeTruthy();
  });
});
