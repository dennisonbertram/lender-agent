// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SignatureBar, SignerRoster } from "./signer-roster";
import { BalanceChanges } from "./balance-changes";
import { FactGrid } from "./fact-grid";
import { ActionBar } from "./action-bar";
import { StatusNote } from "./status-note";
import { Disclosure } from "./disclosure";
import { buttonVariants } from "./button";

afterEach(cleanup);
const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

describe("SignatureBar", () => {
  it("has one segment per required approval and lights the approved count", () => {
    const { container } = render(<SignatureBar threshold={3} lit={1} />);
    expect(container.querySelectorAll("[data-segment]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-lit]")).toHaveLength(1);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("1 of 3 approvals");
  });
});

describe("SignerRoster", () => {
  it("names you, falls back to Co-owner with a short address, and states status in words", () => {
    render(<SignerRoster owners={[{ address: A, isYou: true, status: "saving" }, { address: B, isYou: false, status: "not_yet" }, { address: "0x1111111111111111111111111111111111111111", isYou: false, name: "maya.eth", status: "approved", at: "2:31 pm" }]} />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Co-owner")).toBeTruthy();
    expect(screen.getByText("0x3C44…93BC")).toBeTruthy();
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(screen.getByText("Not yet")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText(/maya\.eth/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")[0].className).toContain("min-h-11");
  });
});

describe("SignerRoster order and copy", () => {
  it("lists You first and gives every address a copy button", () => {
    render(<SignerRoster chainId={8453} owners={[{ address: B, isYou: false, status: "not_yet" }, { address: A, isYou: true, status: "approved" }]} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0].textContent).toContain("You");
    expect(rows[1].textContent).toContain("Co-owner");
    expect(screen.getAllByRole("button", { name: "Copy address" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /View on/ })).toHaveLength(2);
  });
});

describe("BalanceChanges", () => {
  it("shows signed amounts, in vs out tone", () => {
    render(<BalanceChanges rows={[{ label: "You receive", amount: "+2,000 USDC", tone: "in" }, { label: "You lock up", hint: "Held by Morpho", amount: "−1.24 ETH", tone: "out" }]} />);
    expect(screen.getByText("+2,000 USDC").getAttribute("data-tone")).toBe("in");
    expect(screen.getByText("+2,000 USDC").className).toContain("success");
    expect(screen.getByText("−1.24 ETH").className).not.toContain("success");
    expect(screen.getByText("Held by Morpho")).toBeTruthy();
  });
});

describe("FactGrid", () => {
  it("is a definition list with label, value and hint", () => {
    const { container } = render(<FactGrid facts={[{ label: "Lender", value: "Morpho" }, { label: "Interest per year", value: "3.4%", hint: "can change" }]} />);
    expect(container.querySelector("dl")!.className).toContain("grid-cols-1");
    expect(container.querySelector("dl")!.className).toContain("min-[480px]:grid-cols-2");
    expect(screen.getByText("Interest per year").tagName).toBe("DT");
    expect(screen.getByText("can change")).toBeTruthy();
  });
});

describe("ActionBar", () => {
  it("is sticky and safe-area aware, with the headline as a live region and one primary", () => {
    const { container } = render(<ActionBar headline="Your approval is needed" body="Nothing moves." primary={<button>Approve</button>} helper="Free." secondary={[<a key="1" href="#">Check</a>]} />);
    const bar = container.querySelector("[data-slot=action-bar]")!;
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("env(safe-area-inset-bottom)");
    expect(screen.getByRole("heading", { name: "Your approval is needed" }).getAttribute("aria-live")).toBe("polite");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("Free.")).toBeTruthy();
  });
  it("can be non-sticky", () => {
    const { container } = render(<ActionBar headline="x" sticky={false} />);
    expect(container.querySelector("[data-slot=action-bar]")!.className).not.toContain("sticky");
  });
});

describe("StatusNote", () => {
  it("announces bad as an alert and others as a note, always with an icon", () => {
    const { container } = render(<><StatusNote tone="bad">It failed</StatusNote><StatusNote tone="warn">Careful</StatusNote></>);
    expect(screen.getByRole("alert").textContent).toContain("It failed");
    expect(screen.getByRole("note").textContent).toContain("Careful");
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });
});

describe("Disclosure", () => {
  it("is a collapsed details with a 44px summary", () => {
    const { container } = render(<Disclosure summary="Technical details">full hash</Disclosure>);
    const d = container.querySelector("details")!;
    expect(d.open).toBe(false);
    expect(container.querySelector("summary")!.className).toContain("min-h-11");
    expect(screen.getByText("Technical details")).toBeTruthy();
  });
});

describe("Button xl", () => {
  it("is 44px at every pointer", () => {
    expect(buttonVariants({ size: "xl" })).toContain("h-11");
  });
});
