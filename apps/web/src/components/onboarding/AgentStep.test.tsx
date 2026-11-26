// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentStep } from "./AgentStep";

afterEach(cleanup);
const base = { safeAddress: "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe0001", networks: ["Base", "Base Sepolia"], progress: null, busy: false, done: false, onAdd: () => {} };

describe("AgentStep", () => {
  it("for a Safe set up only on an unserved network, says so and offers Add Base", () => {
    const onAddBase = vi.fn();
    render(<AgentStep {...base} networks={[]} otherNetworks={["Optimism"]} onAddBase={onAddBase} />);
    expect(document.body.textContent).toContain("Your Safe is set up on Optimism. Loans and the agent work on Base and Arbitrum; add one of those networks to use them.");
    expect(document.querySelector('img[src="/network-marks/optimism.svg"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Base" }));
    expect(onAddBase).toHaveBeenCalled();
  });
  it("lists what the agent can and cannot do, with no key or seed phrase field", () => {
    const { container } = render(<AgentStep {...base} />);
    expect(screen.getByText("Suggest transactions for you to sign")).toBeTruthy();
    expect(screen.getByText("Sign or approve anything")).toBeTruthy();
    expect(screen.getByText("Move money on its own")).toBeTruthy();
    expect(screen.getByText(/Safe calls this role a proposer\./)).toBeTruthy();
    expect(screen.getByText(/You can remove it anytime in Settings/)).toBeTruthy();
    expect(screen.getByText(/It approves a permission, not a payment\./)).toBeTruthy();
    expect(container.querySelectorAll("input, textarea").length).toBe(0);
    expect(container.textContent?.toLowerCase()).not.toMatch(/seed phrase|private key/);
  });
  it("adds on click and counts the signatures", () => {
    const onAdd = vi.fn();
    const { rerender } = render(<AgentStep {...base} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Lender agent" }));
    expect(onAdd).toHaveBeenCalled();
    rerender(<AgentStep {...base} busy progress={{ chainId: 84532, network: "Base Sepolia", n: 2, total: 2 }} />);
    expect(document.body.textContent).toContain("Confirm in your wallet: Base Sepolia, 2 of 2.");
  });
  it("offers a retry after a cancelled prompt", () => {
    render(<AgentStep {...base} error="You closed the wallet prompt." />);
    expect(screen.getByRole("alert").textContent).toContain("Nothing was changed");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
  it("the done state offers Open chat", () => {
    const onOpenChat = vi.fn();
    render(<AgentStep {...base} done onOpenChat={onOpenChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(onOpenChat).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add Lender agent" })).toBeNull();
  });
  it("with no network, explains instead of a disabled button", () => {
    render(<AgentStep {...base} networks={[]} />);
    expect(screen.getByText("This Safe is not set up on a network we support yet, so the agent cannot be added.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Lender agent" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/no network yet/);
  });
  it("shows the Safe address and says what will be signed, with the agent's address", () => {
    const agent = "0x1111111111111111111111111111111111111111";
    render(<AgentStep {...base} chainId={8453} agentAddress={agent} safeName="Ops" onSkip={() => {}} />);
    expect(screen.getByText("Ops")).toBeTruthy();
    expect(screen.getByText(/You will add the Lender agent/)).toBeTruthy();
    expect(screen.getByText("It can suggest transactions; it cannot sign or move money.")).toBeTruthy();
    expect(screen.getByText(/no transaction is sent and no other owner has to approve/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy address" }).length).toBe(2);
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip, add later in Settings" })).toBeTruthy();
  });
});
