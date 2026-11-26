// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StateMessage } from "./state-message";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("StateMessage", () => {
  it("an error is an alert with a heading, the reason, the reassurance and its actions", () => {
    const onClick = vi.fn();
    render(<StateMessage kind="error" title="Something went wrong on our side" reason="The link may be old." action={{ label: "Try again", onClick }} secondary={{ label: "Back to Overview", href: "/s/1" }} />);
    const alert = screen.getByRole("alert");
    expect(screen.getByRole("heading", { name: "Something went wrong on our side" })).toBeTruthy();
    expect(alert.textContent).toContain("The link may be old.");
    expect(alert.textContent).toContain("Nothing on your Safe has changed.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Back to Overview" }).getAttribute("href")).toBe("/s/1");
  });
  it("a not-found error never says nothing changed, even when the reason already does", () => {
    render(<StateMessage kind="error" title="We could not find this loan" reason="It may have been closed or repaid. Nothing on your Safe has changed." action={{ label: "Back", href: "/s/1" }} />);
    expect(screen.getByRole("alert").textContent).toContain("closed or repaid.");
    expect(screen.getByRole("alert").textContent).not.toContain("Nothing on your Safe has changed");
    cleanup();
    render(<StateMessage kind="error" title="Something went wrong" reason="Try later." reassure={false} action={{ label: "Back", href: "/s/1" }} />);
    expect(screen.getByRole("alert").textContent).not.toContain("Nothing on your Safe");
  });
  it("loading shows nothing for the first second, then a labelled status", () => {
    vi.useFakeTimers();
    render(<StateMessage kind="loading" label="Loading your loan…" />);
    expect(screen.queryByText("Loading your loan…")).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(screen.getByText("Loading your loan…")).toBeTruthy();
  });
});
