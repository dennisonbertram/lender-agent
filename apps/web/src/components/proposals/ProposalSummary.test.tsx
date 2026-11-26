// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProposalSummary } from "./ProposalSummary";
import type { ProposalView } from "@/server/proposals/view";

afterEach(cleanup);
const YOU = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CO = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const p = {
  id: "p1", chainId: 8453, title: "Open a $1,000 loan", steps: [], outcome: "", stage: "queued", segments: [], sentence: "", needsSignatures: 1, signedCount: 1,
  links: { tx: null, queue: "q" }, inSafe: true, safeTxHash: null, hashMismatch: false, nonce: "1", viewerSigned: true, final: false, createdAt: "2026-01-01T00:00:00.000Z", specKind: "open",
  threshold: 2, state: "waiting_for_others", owners: [{ address: CO, signed: false, isYou: false }, { address: YOU, signed: true, isYou: true }],
  facts: { sentence: "", changes: [], terms: [{ label: "Lender", value: "Morpho" }, { label: "Network", value: "Base" }, { label: "Liquidation price", value: "$1,875 per ETH" }], numbers: [{ value: "1,000 USDC", label: "You get" }] },
} as unknown as ProposalView;

describe("ProposalSummary", () => {
  it("shows signer chips with short addresses, You first, and who is waiting", () => {
    render(<ProposalSummary p={p} href="/x" />);
    const row = screen.getByText("1 of 2 approved").parentElement!;
    expect(row.textContent).toMatch(/^1 of 2 approvedYou0x3C44…93BCwaiting$/);
  });
  it("adds one muted line with network, lender and liquidation price", () => {
    render(<ProposalSummary p={p} href="/x" />);
    const network = screen.getByText("Base");
    expect(network.closest("p")?.textContent).toBe("On Base · Morpho · Liquidation price $1,875 per ETH");
    expect(network.parentElement?.querySelector('img[src="/network-marks/base.svg"]')).toBeTruthy();
  });
  it("leaves the line out when the plan has no terms", () => {
    render(<ProposalSummary p={{ ...p, facts: undefined }} href="/x" />);
    expect(screen.queryByText(/^On /)).toBeNull();
  });
  it("says Link copied only after the clipboard accepts", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<ProposalSummary p={p} href="/s/0xabc/proposals/p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link for your co-owner" }));
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
  });
  it("a denied clipboard never says Link copied and shows the link to select", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<ProposalSummary p={p} href="/s/0xabc/proposals/p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link for your co-owner" }));
    await screen.findByDisplayValue("http://localhost:3000/s/0xabc/proposals/p1");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Link copied" })).toBeNull());
  });
});
