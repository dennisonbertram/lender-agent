// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProposalStub } from "./ProposalStub";

afterEach(cleanup);

describe("ProposalStub", () => {
  it("wraps a long title in at most two lines instead of truncating, and keeps it whole in title", () => {
    const t = "Repay 1,000 USDC and withdraw 0.5 ETH from Aave v3 on Base";
    render(<ProposalStub title={t} status="Done" />);
    const el = screen.getByText(t);
    expect(el.className).toContain("line-clamp-2");
    expect(el.className).not.toContain("truncate");
    expect(el.getAttribute("title")).toBe(t);
  });
});
