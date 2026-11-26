// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentOffNotice } from "./AgentOffNotice";

const h = vi.hoisted(() => ({
  add: vi.fn(),
  state: { adding: false, progress: null as null | { network: string; n: number; total: number }, error: null as Error | null },
}));
vi.mock("@/client/agent", () => ({
  useAddAgent: () => ({ add: h.add, adding: h.state.adding, progress: h.state.progress, error: h.state.error, reset: vi.fn() }),
  useAgentStatus: () => ({ data: { agentAddress: "0x00000000000000000000000000000000000000a1", networks: [{ chainId: 8453, deployed: true, added: false }], active: false, otherChainIds: [] } }),
}));

beforeEach(() => { h.add.mockReset(); h.state.adding = false; h.state.progress = null; h.state.error = null; });
afterEach(cleanup);

describe("AgentOffNotice", () => {
  it("explains the agent and offers one button that adds it", async () => {
    h.add.mockResolvedValue({ active: true });
    const onAdded = vi.fn();
    render(<AgentOffNotice safeAddress="0xabc" onAdded={onAdded} />);
    expect(screen.getByText("Add the Lender agent to suggest plans. It can suggest transactions; it cannot sign or move money.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add the agent (one free signature)" }));
    expect(h.add).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });
  it("keeps a link to the full onboarding step", () => {
    render(<AgentOffNotice safeAddress="0xabc" />);
    expect(screen.getByRole("link", { name: "More about the agent" }).getAttribute("href")).toBe("/onboarding/agent?safe=0xabc");
  });
  it("shows what you will sign, with the agent address", () => {
    render(<AgentOffNotice safeAddress="0xabc" />);
    expect(screen.getByText("What you will sign")).toBeTruthy();
  });
  it("shows wallet progress while adding", () => {
    h.state.adding = true;
    h.state.progress = { network: "Base", n: 1, total: 1 };
    render(<AgentOffNotice safeAddress="0xabc" />);
    expect(screen.getByText("Confirm in your wallet: Base, 1 of 1.")).toBeTruthy();
  });
  it("shows the error and offers a retry", () => {
    h.state.error = new Error("The wallet said no.");
    render(<AgentOffNotice safeAddress="0xabc" />);
    expect(screen.getByRole("alert").textContent).toContain("The wallet said no.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
  it("does not call onAdded when the agent is still not on", async () => {
    h.add.mockResolvedValue({ active: false });
    const onAdded = vi.fn();
    render(<AgentOffNotice safeAddress="0xabc" onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: "Add the agent (one free signature)" }));
    await waitFor(() => expect(h.add).toHaveBeenCalled());
    expect(onAdded).not.toHaveBeenCalled();
  });
});
