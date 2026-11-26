// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ProposalView } from "@/server/proposals/view";
import { markApproveIntent } from "@/client/approve-intent";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";
const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const mocks = vi.hoisted(() => ({
  proposal: null as unknown,
  signData: null as unknown,
  wallet: undefined as string | undefined,
  signOpts: undefined as undefined | { beforeWallet?: () => boolean },
  sign: vi.fn(() => Promise.resolve({})),
  exec: vi.fn(() => Promise.resolve({})),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: mocks.wallet }),
  useBalance: () => ({ data: { value: 1n } }),
  usePublicClient: () => undefined,
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/client/loans", () => ({ useLoans: () => ({ data: { loans: [] } }) }));
vi.mock("@/client/proposals", () => ({ useProposal: () => ({ data: mocks.proposal, error: null, refetch: vi.fn() }) }));
vi.mock("@/client/auth/useSession", () => ({ useSignOut: () => vi.fn() }));
vi.mock("@/client/proposals-sign", () => ({
  ProposalActionError: class extends Error { kind = "x"; },
  useSignProposal: (_a: string, _i: string, opts: { beforeWallet?: () => boolean }) => { mocks.signOpts = opts; return { isPending: false, error: null, mutateAsync: mocks.sign }; },
  useExecuteProposal: () => ({ isPending: false, mutateAsync: mocks.exec }),
  useExecuteData: () => ({ data: { ready: true, needs: "ok", fee: { eth: "0.00004", usd: 0.12 } }, refetch: vi.fn() }),
  useSignData: () => ({ data: mocks.signData }),
}));
vi.mock("./RejectAction", () => ({ RejectAction: () => null }));

import { ProposalReview } from "./ProposalReview";

const view = (o: Partial<ProposalView> = {}) => ({
  id: "p1", chainId: 84532, title: "Open a loan", steps: [], outcome: "", stage: "queued", segments: [], sentence: "", needsSignatures: 2, signedCount: 0,
  links: { tx: null, queue: "https://q" }, inSafe: true, safeTxHash: `0x${"ab".repeat(32)}`, hashMismatch: false, nonce: "1", viewerSigned: false, final: false, createdAt: "2026-11-16T14:25:00.000Z", specKind: "open",
  owners: [{ address: ME, signed: false, isYou: true }, { address: "0xother", signed: false, isYou: false }], threshold: 2, state: "needs_your_signature", canSign: true, canSend: false, ...o,
}) as unknown as ProposalView;
const goodSign = { canSign: true, reasons: [], domainHash: "0xd", messageHash: "0xm" };
const STATUS = "Approve in your wallet: check that the code matches before you sign.";

beforeEach(() => { sessionStorage.clear(); mocks.proposal = view(); mocks.signData = goodSign; mocks.wallet = ME; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount = () => render(<ProposalReview safeAddress={SAFE} id="p1" acceptApproveIntent />);

describe("ProposalReview approve intent", () => {
  it("starts the free approval once when the intent is set and every condition holds", async () => {
    markApproveIntent("p1");
    const r = mount();
    await waitFor(() => expect(mocks.sign).toHaveBeenCalledTimes(1));
    r.rerender(<ProposalReview safeAddress={SAFE} id="p1" acceptApproveIntent />);
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("an embedded review (not the proposal page) leaves the intent for the page", async () => {
    markApproveIntent("p1");
    render(<ProposalReview safeAddress={SAFE} id="p1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.sign).not.toHaveBeenCalled();
    cleanup();
    mount();
    await waitFor(() => expect(mocks.sign).toHaveBeenCalledTimes(1));
  });
  it("never starts without the intent", () => {
    mount();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("shows the status line while it waits for the sign data", async () => {
    markApproveIntent("p1");
    mocks.signData = undefined;
    mount();
    await waitFor(() => expect(document.body.textContent).toContain(STATUS));
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  const blocked: [string, () => void][] = [
    ["a blocking sign-data reason", () => { mocks.signData = { ...goodSign, reasons: [{ code: "out_of_date", message: "x", blocksSigning: true }] }; }],
    ["sign data that cannot sign", () => { mocks.signData = { ...goodSign, canSign: false }; }],
    ["a hash mismatch", () => { mocks.proposal = view({ hashMismatch: true }); }],
    ["a viewer who already signed", () => { mocks.proposal = view({ viewerSigned: true, signedCount: 1, state: "waiting_for_others" }); }],
    ["a viewer who is not an owner", () => { mocks.proposal = view({ owners: [{ address: ME, signed: false, isYou: false }] as never }); }],
    ["no connected wallet", () => { mocks.wallet = undefined; }],
    ["a different wallet account", () => { mocks.wallet = "0x1111111111111111111111111111111111111111"; }],
    ["a proposal that is not queued", () => { mocks.proposal = view({ stage: "executed", state: "executed", final: true }); }],
    ["the last approval that also sends (costs gas)", () => { mocks.proposal = view({ signedCount: 1, canSend: true }); }],
  ];
  it.each(blocked)("does nothing with %s", async (_n, setup) => {
    markApproveIntent("p1");
    setup();
    mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("ignores a stale intent", async () => {
    markApproveIntent("p1", Date.now() - 10 * 60_000);
    mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("re-checks the expiry when the wallet connects later: an old mark never prompts", async () => {
    markApproveIntent("p1");
    mocks.wallet = undefined;
    const r = mount();
    await new Promise((res) => setTimeout(res, 10));
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 3 * 60_000);
    mocks.wallet = ME;
    r.rerender(<ProposalReview safeAddress={SAFE} id="p1" acceptApproveIntent />);
    await new Promise((res) => setTimeout(res, 30));
    expect(mocks.sign).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("lets the automatic start through to the wallet only while the page is still the same proposal", async () => {
    markApproveIntent("p1");
    const r = mount();
    await waitFor(() => expect(mocks.sign).toHaveBeenCalledTimes(1));
    expect(mocks.signOpts!.beforeWallet!()).toBe(true);
    r.unmount();
    expect(mocks.signOpts!.beforeWallet!()).toBe(false);
  });
  it("cancels the automatic start when the proposal id changes before the wallet opens", async () => {
    markApproveIntent("p1");
    const r = mount();
    await waitFor(() => expect(mocks.sign).toHaveBeenCalledTimes(1));
    r.rerender(<ProposalReview safeAddress={SAFE} id="p2" acceptApproveIntent />);
    expect(mocks.signOpts!.beforeWallet!()).toBe(false);
  });
  it("a manual click is never held back by the automatic guard", async () => {
    mount();
    expect(mocks.signOpts!.beforeWallet!()).toBe(true);
  });
});
