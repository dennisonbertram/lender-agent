// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NetworksPanel } from "./NetworksPanel";
import type { NetworkRow } from "@/lib/networks";

afterEach(cleanup);
const rows: NetworkRow[] = [
  { id: "base", name: "Base", setup: "deployed", agent: true, line: "Set up · Agent on" },
  { id: "arbitrum", name: "Arbitrum", setup: "deployed", agent: false, line: "Set up · Agent off" },
  { id: "ethereum", name: "Ethereum", setup: "ready", agent: false, line: "Ready, set up automatically on first use · Agent off" },
  { id: "optimism", name: "Optimism", setup: "not-added", agent: false, line: "Not added" },
];
const base = { safeName: "Treasury", rows, progress: null, busy: false, onAddAgent: () => {}, onAddNetwork: () => {} };

describe("NetworksPanel (BP-35)", () => {
  it("shows set up / ready on first use, and the agent on or off, per network", () => {
    render(<NetworksPanel {...base} />);
    const item = (name: string) => within(screen.getByRole("listitem", { name }));
    expect(item("Base").getByText("Set up · Agent on")).toBeTruthy();
    expect(item("Arbitrum").getByText("Set up · Agent off")).toBeTruthy();
    expect(item("Ethereum").getByText("Ready, set up automatically on first use · Agent off")).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: "Optimism" })).toBeNull();
  });
  it("asks for one signature to add the agent where the Safe is set up and the agent is off", () => {
    const onAddAgent = vi.fn();
    render(<NetworksPanel {...base} onAddAgent={onAddAgent} />);
    expect(screen.queryByRole("button", { name: "Add agent to Base" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add agent to Ethereum" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add agent to Arbitrum" }));
    expect(onAddAgent).toHaveBeenCalledWith("arbitrum");
  });
  it("Add network lists only networks that are not added and says what the signature is for", () => {
    const onAddNetwork = vi.fn();
    render(<NetworksPanel {...base} onAddNetwork={onAddNetwork} />);
    const select = screen.getByLabelText("Add a network") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["optimism"]);
    expect(screen.getByText(/same address on every network/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add network" }));
    expect(onAddNetwork).toHaveBeenCalledWith("optimism");
  });
  it("shows the wallet prompt progress and disables the buttons while signing", () => {
    render(<NetworksPanel {...base} busy progress={{ chainId: 42161, network: "Arbitrum", n: 1, total: 1 }} />);
    expect(screen.getByText("Confirm in your wallet: Arbitrum, 1 of 1.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add agent to Arbitrum" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("says so when every network is added", () => {
    render(<NetworksPanel {...base} rows={rows.slice(0, 3)} />);
    expect(screen.getByText("Every network is added.")).toBeTruthy();
  });
  it("explains how the agent gets switched on where the Safe is only ready (F-STORY-100-03)", () => {
    render(<NetworksPanel {...base} />);
    expect(within(screen.getByRole("listitem", { name: "Ethereum" })).getByText(/Switch the agent on when you first use this network/)).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "Arbitrum" })).queryByText(/when you first use/)).toBeNull();
  });
});
