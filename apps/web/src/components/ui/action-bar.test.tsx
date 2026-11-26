// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionBar } from "./action-bar";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const phone = (on: boolean) => vi.stubGlobal("matchMedia", () => ({ matches: on, addEventListener() {}, removeEventListener() {} }));
const bar = (extra = {}) => render(<ActionBar headline="H" primary={<button>Go</button>} secondary={[<button key="a">Only approve</button>, <button key="b">Reject this plan</button>, <a key="c" href="#">Check in Safe</a>]} {...extra} />);

describe("ActionBar", () => {
  it("wide: every secondary action is inline", () => {
    phone(false);
    bar();
    expect(screen.getByText("Reject this plan")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
  });
  it("phone: secondary actions fold behind More options, which reveals all of them", () => {
    phone(true);
    bar();
    expect(screen.queryByText("Reject this plan")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByText("Reject this plan")).toBeTruthy();
    expect(screen.getByText("Check in Safe")).toBeTruthy();
  });
  it("phone: the wallet check is one toggle instead of the long note; wide keeps the note", () => {
    phone(true);
    bar({ note: <p>LONG NOTE</p>, detail: { label: "What to check in your wallet", content: <p>LONG NOTE</p> } });
    expect(screen.queryByText("LONG NOTE")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What to check in your wallet" }));
    expect(screen.getByText("LONG NOTE")).toBeTruthy();
    cleanup();
    phone(false);
    bar({ note: <p>LONG NOTE</p>, detail: { label: "What to check in your wallet", content: <p>LONG NOTE</p> } });
    expect(screen.getByText("LONG NOTE")).toBeTruthy();
  });
  it("phone: the primary button and More options share one row; the caption is one line", () => {
    phone(true);
    bar({ body: "A long caption", helper: "A helper" });
    const more = screen.getByRole("button", { name: "More options" });
    expect(more.parentElement).toBe(screen.getByText("Go").parentElement!.parentElement);
    expect(screen.getByText("A long caption").className).toContain("line-clamp-1");
    expect(screen.getByText("A helper").className).toContain("line-clamp-1");
  });
  it("phone: a single secondary action stays inline", () => {
    phone(true);
    render(<ActionBar headline="H" secondary={[<button key="a">Sign out</button>]} />);
    expect(screen.getByText("Sign out")).toBeTruthy();
  });
});
