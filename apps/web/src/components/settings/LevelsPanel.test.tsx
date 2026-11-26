// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LevelsPanel, type LevelsLoan } from "./LevelsPanel";

afterEach(cleanup);
const loan: LevelsLoan = { id: "8453:0xabc:aave-v3", lender: "Aave v3", asset: "ETH", healthFactor: 1.5, status: "watch", levels: { warn: 1.6, act: 1.35 } };

describe("LevelsPanel (BP-19)", () => {
  it("is marked paused only when the agent is not added", () => {
    const { rerender } = render(<LevelsPanel loans={[loan]} onSave={async () => ""} />);
    expect(screen.queryByText("Paused: agent not added")).toBeNull();
    rerender(<LevelsPanel loans={[loan]} onSave={async () => ""} paused />);
    expect(screen.getByText("Paused: agent not added")).toBeTruthy();
  });

  it("opens with a short plain-words intro", () => {
    render(<LevelsPanel loans={[loan]} onSave={async () => ""} />);
    expect(screen.getByText("Health shows how safe a loan is: higher is safer, and below 1.0 the lender can sell your collateral. Below Watch you get an early heads-up; below At risk the agent suggests a fix. Use numbers from 1.0 to 5.0, with At risk lower than Watch.")).toBeTruthy();
    expect(screen.queryByText(/Health factor/)).toBeNull();
  });

  it("labels the fields Watch level and At-risk level", () => {
    render(<LevelsPanel loans={[loan]} onSave={async () => ""} />);
    expect(screen.getByText("Watch level")).toBeTruthy();
    expect(screen.getByText("At-risk level")).toBeTruthy();
    expect(screen.getByText("Health 1.50 · Watch")).toBeTruthy();
  });

  it("saves on Enter and shows the server's Saved line", async () => {
    const onSave = vi.fn(async () => "Saved. Aave v3 now shows Healthy, not Watch (health 1.50).");
    render(<LevelsPanel loans={[loan]} onSave={onSave} />);
    const warn = screen.getByLabelText("Aave v3 watch level");
    fireEvent.change(warn, { target: { value: "1.4" } });
    fireEvent.keyDown(warn, { key: "Enter" });
    await screen.findByText("Saved. Aave v3 now shows Healthy, not Watch (health 1.50).");
    expect(onSave).toHaveBeenCalledWith(loan.id, "1.4", "1.35");
  });

  it("saves on blur", async () => {
    const onSave = vi.fn(async () => "Saved.");
    render(<LevelsPanel loans={[loan]} onSave={onSave} />);
    const act = screen.getByLabelText("Aave v3 at-risk level");
    fireEvent.change(act, { target: { value: "1.2" } });
    fireEvent.blur(act);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(loan.id, "1.6", "1.2"));
  });

  it("invalid input: the specific message, field marked, nothing saved", async () => {
    const onSave = vi.fn(async () => "x");
    render(<LevelsPanel loans={[loan]} onSave={onSave} />);
    const act = screen.getByLabelText("Aave v3 at-risk level");
    fireEvent.change(act, { target: { value: "1.7" } });
    fireEvent.keyDown(act, { key: "Enter" });
    expect(await screen.findByText("At-risk level must be below Watch level. Not saved.")).toBeTruthy();
    expect(act.getAttribute("aria-invalid")).toBe("true");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a server refusal is shown, not swallowed", async () => {
    render(<LevelsPanel loans={[loan]} onSave={async () => { throw new Error("Not allowed"); }} />);
    const warn = screen.getByLabelText("Aave v3 watch level");
    fireEvent.change(warn, { target: { value: "2" } });
    fireEvent.keyDown(warn, { key: "Enter" });
    expect(await screen.findByText("Not allowed Not saved.")).toBeTruthy();
  });
});
