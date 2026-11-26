// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FixOptionRow } from "./FixOptionRow";

afterEach(cleanup);

describe("FixOptionRow (VC-03)", () => {
  it("is a pressed-state button with a pointer cursor", () => {
    const onClick = vi.fn();
    render(<FixOptionRow label="Add 1 ETH" sub="From your Safe" chosen onClick={onClick} />);
    const b = screen.getByRole("button", { name: /Add 1 ETH/ });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.className).toContain("cursor-pointer");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });
  it("unchosen is aria-pressed=false; disabled stays disabled", () => {
    render(<FixOptionRow label="Repay" sub="Needs more" chosen={false} disabled onClick={() => {}} />);
    const b = screen.getByRole("button", { name: /Repay/ }) as HTMLButtonElement;
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.disabled).toBe(true);
  });
});
