// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Safe } from "@/lib/types";
import { ShellProvider, useSafeNickname } from "@/components/shell/ShellContext";
import { SafeNicknameEditor } from "./SafeNicknameEditor";

const ADDRESS = "0x" + "a".repeat(40);
const safe: Safe = { id: "id", name: "Service name", address: ADDRESS, threshold: "1", agent: false, networks: [], balances: {} };
function Harness() {
  const { safeNickname, setSafeNickname } = useSafeNickname();
  return <SafeNicknameEditor address={safe.address} safeName={safe.name} nickname={safeNickname(safe.address)} setSafeNickname={setSafeNickname} />;
}

describe("SafeNicknameEditor", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("keeps a nickname loaded after first render in the untouched editor draft", async () => {
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn={false} watching={false} walletAddress="0xWallet"><Harness /></ShellProvider>);
    const key = "la:safeNickname:0xwallet:" + ADDRESS;
    localStorage.setItem(key, JSON.stringify("Home Vault"));
    window.dispatchEvent(new StorageEvent("storage", { key }));
    const input = await waitFor(() => {
      const field = screen.getByRole("textbox", { name: "Safe nickname" }) as HTMLInputElement;
      expect(field.value).toBe("Home Vault");
      return field;
    });
    fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
    expect(input.value).toBe("Home Vault");
    expect(JSON.parse(localStorage.getItem(key)!)).toBe("Home Vault");
  });
  it("keeps an explicit nickname equal to the default until the user removes it", async () => {
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn={false} watching={false} walletAddress="0xWallet"><Harness /></ShellProvider>);
    const key = "la:safeNickname:0xwallet:" + ADDRESS;
    localStorage.setItem(key, JSON.stringify("Service name"));
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(await screen.findByRole("button", { name: "Use default name" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Safe nickname" }) as HTMLInputElement).value).toBe("Service name");
    fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
    expect((screen.getByRole("textbox", { name: "Safe nickname" }) as HTMLInputElement).value).toBe("Service name");
    expect(screen.getByRole("button", { name: "Use default name" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use default name" }));
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use default name" })).toBeNull();
  });
  it("keeps the draft and confirmed display when storage rejects a write", () => {
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn={false} watching={false} walletAddress="0xWallet"><Harness /></ShellProvider>);
    const input = screen.getByRole("textbox", { name: "Safe nickname" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Local draft" } });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
    fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
    expect(input.value).toBe("Local draft");
    expect(screen.getByRole("status").textContent).toMatch(/could not be saved/i);
    expect(screen.getByRole("region", { name: "Safe nickname" }).textContent).toContain("Default name: Service name");
  });
  it("does not save on IME composition Enter, but saves on ordinary Enter", () => {
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn={false} watching={false} walletAddress="0xWallet"><Harness /></ShellProvider>);
    const key = "la:safeNickname:0xwallet:" + ADDRESS;
    const input = screen.getByRole("textbox", { name: "Safe nickname" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "京都の家" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(localStorage.getItem(key)).toBeNull();
    expect(input.value).toBe("京都の家");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(localStorage.getItem(key)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(JSON.parse(localStorage.getItem(key)!)).toBe("京都の家");
  });
});
