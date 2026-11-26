// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailPanel } from "./EmailPanel";

afterEach(cleanup);

describe("EmailPanel", () => {
  it("says the address gets at-risk alerts and approval requests", () => {
    render(<EmailPanel value={{ email: null, enabled: true }} onSave={vi.fn()} />);
    expect(screen.getByText(/At-risk level.*plan needs approval.*enabled address and available delivery/)).toBeTruthy();
  });
  it("confirms a saved address with a status line (F-STORY-072-01)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EmailPanel value={{ email: null, enabled: true }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "dana@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved. Email address updated; delivery setting unchanged."));
    expect(onSave).toHaveBeenCalledWith({ email: "dana@example.com" });
  });
  it("says emails are off or on after the toggle (F-STORY-076-03)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EmailPanel value={{ email: "dana@example.com", enabled: true }} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Send me email"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved. Emails are off."));
  });
  it("shows no success message when saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Nope."));
    render(<EmailPanel value={{ email: null, enabled: true }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nope. Not saved."));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("changes delivery without resubmitting an unchanged address", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EmailPanel value={{ email: "old@example.com", enabled: true }} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Send me email"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ enabled: false }));
  });

  it("saves a valid edited address with the delivery switch in one request", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EmailPanel value={{ email: "old@example.com", enabled: true }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByLabelText("Send me email"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ email: "new@example.com", enabled: false }));
  });

  it("lets a borrower turn delivery off with an invalid unsaved address", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EmailPanel value={{ email: "old@example.com", enabled: true }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByLabelText("Send me email"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ enabled: false }));
    expect((await screen.findByRole("status")).textContent).toContain("The edited address was not saved because it is invalid.");
  });

  it("keeps the saved address when the draft is blank and the borrower turns delivery off", async () => {
    const onSave = vi.fn().mockResolvedValue({ email: "old@example.com", enabled: false, deliveryConfigured: true });
    render(<EmailPanel value={{ email: "old@example.com", enabled: true }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Send me email"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ enabled: false }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("requires a valid destination before enabling email", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EmailPanel value={{ email: null, enabled: false }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByLabelText("Send me email"));
    expect(onSave).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a valid email address before turning email alerts on.");
  });

  it("does not claim delivery when an email-only save returns an unsubscribed setting", async () => {
    const onSave = vi.fn().mockResolvedValue({ email: "new@example.com", enabled: false, deliveryConfigured: true });
    render(<EmailPanel value={{ email: "old@example.com", enabled: true }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("status")).textContent).toContain("Email address updated; delivery setting unchanged.");
    expect(screen.queryByText(/Alerts go to new@example.com/)).toBeNull();
  });

  it("does not claim alerts will be delivered when the provider is unavailable", async () => {
    const onSave = vi.fn().mockResolvedValue({ email: "new@example.com", enabled: true, deliveryConfigured: false });
    render(<EmailPanel value={{ email: "old@example.com", enabled: true, deliveryConfigured: false }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("status")).textContent).toContain("delivery is not configured here");
    expect(screen.queryByText(/Alerts go to new@example.com/)).toBeNull();
  });

  it("locks the controls until a save finishes, so responses cannot arrive out of order", async () => {
    let finish: (() => void) | undefined;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<EmailPanel value={{ email: "old@example.com", enabled: true }} onSave={onSave} />);
    const address = screen.getByLabelText("Email address") as HTMLInputElement;
    const toggle = screen.getByLabelText("Send me email") as HTMLInputElement;
    fireEvent.change(address, { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saving = await screen.findByRole("button", { name: "Saving…" }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect(address.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onSave).toHaveBeenCalledTimes(1);
    finish?.();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved. Email address updated; delivery setting unchanged."));
  });
});
