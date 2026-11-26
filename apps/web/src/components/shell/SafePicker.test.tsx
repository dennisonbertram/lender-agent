// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Safe } from "@/lib/types";
import { shortAddress } from "@/lib/address";
import { SafePicker } from "./Sidebar";

afterEach(cleanup);
const mk = (id: string, address: string): Safe => ({ id, name: id, address, threshold: "2/3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} });

describe("SafePicker", () => {
  it("opens the chosen Safe's overview, not its chat (F-STORY-065-02)", async () => {
    const onNavigate = vi.fn();
    const a = mk("alpha", "0xaaa"), b = mk("beta", "0xbbb");
    render(<SafePicker safe={a} safes={[a, b]} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /beta/ }));
    expect(onNavigate).toHaveBeenCalledWith("/s/0xbbb");
  });

  it("shows the agent state of the current Safe only; other Safes carry no status line", async () => {
    const a = mk("alpha", "0xaaa"), b = mk("beta", "0xbbb");
    render(<SafePicker safe={a} safes={[a, b]} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    await screen.findByRole("menuitem", { name: /beta/ });
    expect(screen.queryByText("Agent not added")).toBeNull();
    expect(screen.getAllByText("Agent on · no loans yet")).toHaveLength(1);
  });

  it("shows the current Safe's address with copy and explorer link, and no duplicate second line", async () => {
    const A = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe0001";
    const a = { ...mk(A, A), name: shortAddress(A) };
    render(<SafePicker safe={a} safes={[a]} chainId={84532} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /0x5/ }));
    await screen.findByText("Safe address");
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /View on Basescan/ }).getAttribute("href")).toContain("sepolia.basescan.org/address/");
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
    expect(screen.getAllByText(shortAddress(A)).filter((e) => e.closest("[role=menuitem]"))).toHaveLength(1);
  });
});
