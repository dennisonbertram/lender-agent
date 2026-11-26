// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellProvider, useSafeNickname } from "./ShellContext";
import type { Safe } from "@/lib/types";

const ADDRESS = `0x${"a".repeat(40)}`;
const safe: Safe = { id: "id", name: "Original Safe", address: ADDRESS, threshold: "1", agent: false, networks: [], balances: {} };
function Probe() {
  const { safeName, setSafeNickname } = useSafeNickname();
  const [result, setResult] = useState("");
  return <><span>{safeName(ADDRESS.toUpperCase(), "Original Safe")}</span><button onClick={() => setResult(String(setSafeNickname(ADDRESS.toUpperCase(), "  Family   Vault  ")))}>rename</button><button onClick={() => setSafeNickname(ADDRESS, "")}>clear</button><output>{result}</output></>;
}
const app = (walletAddress: string) => <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn={false} watching={false} walletAddress={walletAddress}><Probe /></ShellProvider>;

describe("Safe nicknames", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => localStorage.clear());
  it("normalizes address and whitespace, stores only in this wallet scope, and clears to the Safe name", () => {
    const { rerender } = render(app("0xWALLET1"));
    fireEvent.click(screen.getByText("rename"));
    expect(screen.getByText("Family Vault")).toBeTruthy();
    expect(localStorage.getItem(`la:safeNickname:0xwallet1:${ADDRESS}`)).toBe('"Family Vault"');
    rerender(app("0xWALLET2"));
    expect(screen.getByText("Original Safe")).toBeTruthy();
    fireEvent.click(screen.getByText("rename"));
    fireEvent.click(screen.getByText("clear"));
    expect(screen.getByText("Original Safe")).toBeTruthy();
  });
  it("falls back safely on malformed storage and reports rejected writes", () => {
    localStorage.setItem(`la:safeNickname:0xwallet1:${ADDRESS}`, "not-json");
    render(app("0xWALLET1"));
    expect(screen.getByText("Original Safe")).toBeTruthy();
    const rejected = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
    fireEvent.click(screen.getByText("rename"));
    expect(screen.getByText("false")).toBeTruthy();
    expect(screen.getByText("Original Safe")).toBeTruthy();
    rejected.mockRestore();
  });
});
