// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProposalView } from "@/server/proposals/view";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";
const mocks = vi.hoisted(() => ({
  proposal: null as unknown,
  balance: vi.fn((_a?: unknown) => ({ data: { value: 0n } })),
  receipt: vi.fn(),
  exec: vi.fn(),
  sign: vi.fn(),
  refetch: vi.fn(),
  executeData: null as null | { data?: { ready: boolean; needs: string; fee?: { eth: string; usd: number } }; isError: boolean },
  onSubmitted: null as null | ((h: string) => void),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
  useBalance: (args: unknown) => mocks.balance(args as never),
  usePublicClient: () => ({ getTransactionReceipt: mocks.receipt }),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/client/loans", () => ({ useLoans: () => ({ data: { loans: [] } }) }));
vi.mock("@/client/proposals", () => ({ useProposal: () => ({ data: mocks.proposal, error: null, refetch: vi.fn() }) }));
vi.mock("@/client/auth/useSession", () => ({ useSignOut: () => vi.fn() }));
vi.mock("@/client/proposals-sign", () => ({
  ProposalActionError: class extends Error { constructor(public kind: string, message: string) { super(message); this.name = "ProposalActionError"; } },
  useSignProposal: () => ({ isPending: false, error: null, mutateAsync: mocks.sign }),
  useExecuteProposal: (_a: string, _i: string, o: { onSubmitted: (h: string) => void }) => { mocks.onSubmitted = o.onSubmitted; return { isPending: false, mutateAsync: mocks.exec }; },
  useExecuteData: () => ({ ...(mocks.executeData ?? { data: { ready: true, needs: "ok", fee: { eth: "0.00004", usd: 0.12 } }, isError: false }), refetch: mocks.refetch }),
  useSignData: () => ({ data: null }),
}));
vi.mock("./RejectAction", () => ({ RejectAction: () => null }));

import { ProposalActionError } from "@/client/proposals-sign";
import { ProposalReview } from "./ProposalReview";

afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState({}, "", "/"); mocks.executeData = null; mocks.balance.mockImplementation((_a?: unknown) => ({ data: { value: 0n } })); });
const view = (o: Partial<ProposalView>) => ({
  id: "p1", chainId: 84532, title: "Open a loan", steps: [], outcome: "", stage: "queued", segments: [], sentence: "", needsSignatures: 0, signedCount: 2,
  links: { tx: null, queue: "https://q" }, inSafe: true, safeTxHash: null, hashMismatch: false, nonce: "1", viewerSigned: true, final: false, createdAt: "2026-11-16T14:25:00.000Z", specKind: "open",
  owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: true, isYou: true }], threshold: 2, state: "ready_to_send", canSign: false, canSend: true, ...o,
}) as unknown as ProposalView;

describe("ProposalReview wiring", () => {
  it("reads the fee balance on the proposal's network and names it", () => {
    mocks.proposal = view({});
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    expect(mocks.balance).toHaveBeenCalledWith(expect.objectContaining({ chainId: 84532 }));
    expect(document.body.textContent).toContain("ETH on Base Sepolia. This wallet has no ETH.");
  });
  it("shows the fee from the receipt, not the estimate", async () => {
    mocks.proposal = view({});
    mocks.receipt.mockResolvedValue({ gasUsed: 200_000n, effectiveGasPrice: 100_000_000n });
    const r = render(<ProposalReview safeAddress={SAFE} id="p1" />);
    act(() => mocks.onSubmitted!(`0x${"ab".repeat(32)}`));
    mocks.proposal = view({ stage: "executed", state: "executed", final: true, owners: undefined });
    r.rerender(<ProposalReview safeAddress={SAFE} id="p1" />);
    await waitFor(() => expect(document.body.textContent).toContain("Network fee paid: 0.00002 ETH ($0.06), by you."));
    expect(mocks.receipt).toHaveBeenCalledWith({ hash: `0x${"ab".repeat(32)}` });
  });
  it("without a receipt it never says paid", () => {
    mocks.proposal = view({ stage: "executed", state: "executed", final: true, owners: undefined });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    expect(document.body.textContent).not.toMatch(/fee paid|paid by/i);
  });
  it("says Link copied only after the clipboard accepts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.proposal = view({ state: "waiting_for_others", viewerSigned: true, signedCount: 1, needsSignatures: 1, owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: true, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: false, isYou: false }], canSend: false });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link for your co-owner" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Link copied" });
  });
  it("a denied clipboard never says Link copied and shows the link to select", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.proposal = view({ state: "waiting_for_others", viewerSigned: true, signedCount: 1, needsSignatures: 1, owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: true, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: false, isYou: false }], canSend: false });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link for your co-owner" }));
    await screen.findByDisplayValue(`http://localhost:3000/s/${SAFE}/proposals/p1`);
    expect(screen.queryByRole("button", { name: "Link copied" })).toBeNull();
  });
  it("shares the proposal URL even when review is embedded on Get cash", async () => {
    window.history.replaceState({}, "", `/s/${SAFE}/get-cash`);
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.proposal = view({ state: "waiting_for_others", viewerSigned: true, signedCount: 1, needsSignatures: 1, owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: true, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: false, isYou: false }], canSend: false });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link for your co-owner" }));
    expect(await screen.findByDisplayValue(`http://localhost:3000/s/${SAFE}/proposals/p1`)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(`http://localhost:3000/s/${SAFE}/proposals/p1`);
  });
  it("a failing approve-and-send precheck surfaces the reason, recovery and the free approval", async () => {
    mocks.balance.mockImplementation(() => ({ data: { value: 1000000000000000000n } }));
    mocks.exec.mockRejectedValueOnce(new ProposalActionError("simulation_failed", "Morpho refused the loan: ETH's price moved"));
    mocks.proposal = view({ state: "needs_your_signature", viewerSigned: false, signedCount: 1, needsSignatures: 1, canSign: true, canSend: true, owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: false, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: true, isYou: false }] });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("ETH's price moved");
    expect(note.textContent).toContain("Nothing was approved or sent");
    expect(screen.queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Only approve (free)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Make a new plan" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });
  it("a failed check-again request preserves the simulation failure and keeps sending unavailable", async () => {
    mocks.balance.mockImplementation(() => ({ data: { value: 1000000000000000000n } }));
    mocks.exec.mockRejectedValueOnce(new ProposalActionError("simulation_failed", "Morpho refused the loan: ETH's price moved"));
    mocks.refetch.mockResolvedValueOnce({ isError: true, error: new Error("network unavailable"), data: { ready: true, needs: "ok" } });
    mocks.proposal = view({ state: "needs_your_signature", viewerSigned: false, signedCount: 1, needsSignatures: 1, canSign: true, canSend: true, owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: false, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: true, isYou: false }] });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await screen.findByRole("note");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
    expect(screen.getByText(/couldn't check the latest proposal state/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and send" })).toBeNull();
  });
  it("a missing or failed precheck never enables approve-and-send", () => {
    mocks.executeData = { data: undefined, isError: true };
    mocks.balance.mockImplementation(() => ({ data: { value: 1000000000000000000n } }));
    mocks.proposal = view({ state: "needs_your_signature", viewerSigned: false, signedCount: 1, needsSignatures: 1, canSign: true, canSend: true, owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: false, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: true, isYou: false }] });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    expect(screen.queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });
  it("a failed send cannot retry from stale cached readiness after its recheck errors", () => {
    mocks.executeData = { data: { ready: true, needs: "ok" }, isError: true };
    mocks.proposal = view({ stage: "failed", state: "failed", canSend: true, owners: undefined, final: true, failedReason: "The transaction reverted." });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    expect(screen.queryByRole("button", { name: "Try sending again" })).toBeNull();
    expect(screen.getByRole("link", { name: "Make a new plan" })).toBeTruthy();
  });
  it("an insufficient-fee error leaves the last owner's approval as the safe next step", async () => {
    mocks.balance.mockImplementation(() => ({ data: { value: 1000000000000000000n } }));
    mocks.exec.mockRejectedValueOnce(new ProposalActionError("insufficient_funds", "This wallet doesn't have enough ETH for the network fee."));
    mocks.proposal = view({ state: "needs_your_signature", viewerSigned: false, signedCount: 1, needsSignatures: 1, canSign: true, canSend: true, owners: [{ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signed: false, isYou: true }, { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", signed: true, isYou: false }] });
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await screen.findByText(/approve in your wallet first/i);
    expect(screen.getByRole("button", { name: "Approve in your wallet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/co-owner can send/i);
  });
});
