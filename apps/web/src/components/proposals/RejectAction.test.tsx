// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RejectWarning, trapTab } from "./RejectAction";

afterEach(cleanup);

describe("trapTab", () => {
  const dialog = () => render(<div data-testid="d" onKeyDown={trapTab}><button>Keep it</button><button>Reject plan</button></div>);
  it("Tab from the last control returns to the first; Shift+Tab from the first goes to the last", () => {
    dialog();
    const [keep, reject] = screen.getAllByRole("button");
    reject.focus();
    fireEvent.keyDown(reject, { key: "Tab" });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(keep, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(reject);
  });
  it("Tab between the two inside controls is left to the browser", () => {
    dialog();
    const [keep] = screen.getAllByRole("button");
    keep.focus();
    expect(fireEvent.keyDown(keep, { key: "Tab" })).toBe(true);
  });
});

describe("RejectWarning", () => {
  it("says nothing extra when nobody approved", () => {
    render(<RejectWarning approvals={0} queueHref="https://safe/queue" />);
    expect(screen.queryByText(/already given/)).toBeNull();
  });
  it("states the approvals given, that Safe can still run it, and links to reject there", () => {
    render(<RejectWarning approvals={1} queueHref="https://safe/queue" />);
    expect(screen.getByText(/1 approval is already given/).textContent).toMatch(/still be sent from there/);
    expect((screen.getByRole("link", { name: /Reject in Safe/ }) as HTMLAnchorElement).href).toBe("https://safe/queue");
  });
});
