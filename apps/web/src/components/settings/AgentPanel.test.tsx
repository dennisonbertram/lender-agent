// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShellProvider } from "@/components/shell/ShellContext";
import type { Safe } from "@/lib/types";
import { AgentPanel as Panel, type AgentPanelProps } from "./AgentPanel";

const safe: Safe = { id: "s", name: "S", address: "0xabc", threshold: "", agent: true, networks: [], balances: {} };
const AgentPanel = (p: AgentPanelProps) => <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn={p.activeNetworks.length > 0} watching><Panel {...p} /></ShellProvider>;

afterEach(cleanup);
const base = { agentAddress: "0xagent", activeNetworks: ["Base"], progress: null, busy: false, onAdd: () => {}, onRemove: () => {} };

describe("AgentPanel", () => {
  it("asks to confirm before removing", () => {
    const onRemove = vi.fn();
    render(<AgentPanel {...base} onRemove={onRemove} />);
    expect(screen.getByText(/Can suggest transactions on Base \(Safe calls this a proposer\)\. Cannot sign or move money\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));
    expect(screen.getByText("Remove the Lender agent from this Safe?")).toBeTruthy();
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalled();
  });
  it("says open loans stop being watched when removing", () => {
    render(<AgentPanel {...base} loans={[{ lender: "Morpho Blue", debtUsd: 1000 }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));
    expect(screen.getByText("Your $1,000 Morpho loan will no longer be watched or fixed automatically.")).toBeTruthy();
  });
  it("does not invent a zero dollar debt when the loan value is unavailable", () => {
    render(<AgentPanel {...base} loans={[{ lender: "Morpho Blue", debtUsd: null }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));
    expect(screen.getByText("Your Morpho loan's debt value is unavailable. It will no longer be watched or fixed automatically.")).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });
  it("says nothing about loans when there are none", () => {
    render(<AgentPanel {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));
    expect(screen.queryByText(/no longer be watched/)).toBeNull();
  });
  it("offers Add agent to this Safe when off", () => {
    const onAdd = vi.fn();
    render(<AgentPanel {...base} activeNetworks={[]} onAdd={onAdd} />);
    expect(screen.getByText("Not added to this Safe.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add agent to this Safe" }));
    expect(onAdd).toHaveBeenCalled();
  });
  it("shows the agent address checksummed with copy and an explorer link, full address in the title", () => {
    render(<AgentPanel {...base} chainId={8453} agentAddress="0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" />);
    expect(screen.getByText("Agent address")).toBeTruthy();
    expect(screen.getByText("0x9965…A4dc").getAttribute("title")).toBe("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View on Basescan" }).getAttribute("href")).toBe("https://basescan.org/address/0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
  });
  it("names the agent, the networks and who signs before Remove", () => {
    render(<AgentPanel {...base} agentAddress="0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));
    expect(screen.getByText(/Removes 0x9965…A4dc on Base\./)).toBeTruthy();
    expect(screen.getByText(/You sign a message in your wallet for each network; no other owner needs to sign/)).toBeTruthy();
  });
});
