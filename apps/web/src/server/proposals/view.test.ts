import { describe, expect, it } from "vitest";
import { safeTxHash } from "@/server/safe/hash";
import { safeQueueLink, safeTxLink } from "@/server/safe/links";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE } from "@/server/mock/seed";
import type { SafeTx } from "@/shared/types";
import { proposalView, stageOf, type ProposalRow } from "./view";

const tx: SafeTx = { to: "0x1111111111111111111111111111111111111111", value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: "7" };
const hash = safeTxHash(8453, MOCK_SAFE, tx);
const conf = (owner: string) => ({ owner, submittedAt: "2026-01-01T00:00:00Z" });

const row = (o: Partial<ProposalRow> = {}): ProposalRow => ({
  id: "p1", safeId: 1, chainId: 8453, spec: {}, tx, nonce: 7n, safeTxHash: hash, idempotencyKey: "k", title: "Protect Aave loan", steps: ["a", "b"], outcome: "Uses 1 ETH.",
  stage: "queued", confirmations: [], threshold: 2, executedTxHash: null, testRun: null, stopReason: null, deletedFromQueue: false, submissionAttemptedAt: null, replacedBy: null, createdBy: null,
  createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"), ...o,
} as ProposalRow);
const view = (o: Partial<ProposalRow> = {}, threshold = 2) => proposalView(row(o), { viewer: MOCK_COSIGNER, threshold, safeAddress: MOCK_SAFE });

describe("stageOf", () => {
  it("has one segment per signature plus the run", () => {
    expect(stageOf(row({ stage: "draft" }), 2)).toEqual({ index: 0, segments: ["todo", "todo", "todo"] });
    expect(stageOf(row({ stage: "queued" }), 2).segments).toEqual(["current", "todo", "todo"]);
    expect(stageOf(row({ stage: "queued", confirmations: [conf(MOCK_OWNER)] }), 2).segments).toEqual(["done", "current", "todo"]);
    expect(stageOf(row({ stage: "queued", confirmations: [conf(MOCK_OWNER), conf(MOCK_COSIGNER)] }), 2).segments).toEqual(["done", "done", "current"]);
    expect(stageOf(row({ stage: "executed" }), 2).segments).toEqual(["done", "done", "done"]);
    expect(stageOf(row({ stage: "queued" }), 1).segments).toEqual(["current", "todo"]);
    expect(stageOf(row({ stage: "rejected" }), 2)).toEqual({ index: -1, segments: ["todo", "todo", "todo"] });
  });
});

describe("proposalView", () => {
  it("tells the owner to check Safe when submission intent is unresolved", () => {
    const pending = view({ stage: "sending", submissionAttemptedAt: new Date("2026-11-18T00:00:00Z") });
    expect(pending.sentence).toBe("Safe submission outcome is being checked. Review your Safe queue; do not send this transaction again.");
    expect(pending.state).toBeNull();
    expect(pending.final).toBe(false);
  });
  it("a 2-of-2 proposal with one signature has threshold+1 segments and one lit signature segment", () => {
    const v = view({ confirmations: [conf(MOCK_OWNER)] });
    expect(v.segments).toEqual(["done", "current", "todo"]);
    expect(v.segments.filter((x) => x === "done")).toHaveLength(1);
    expect(v.countLabel).toBe("1 of 2 signed");
  });
  it("counts signatures in words", () => {
    expect(view().countLabel).toBe("0 of 2 signed");
    expect(view({}, 1).countLabel).toBe("0 of 1 signed");
    expect(view({ confirmations: [conf(MOCK_OWNER), conf(MOCK_COSIGNER)] }).countLabel).toBe("All signed");
    expect(view({ stage: "draft", tx: null, safeTxHash: null }).countLabel).toBeUndefined();
    expect(view({ stage: "executed" }).countLabel).toBeUndefined();
    expect(view({ stage: "rejected" }).countLabel).toBeUndefined();
  });
  it("says what ran, with the amount for an open", () => {
    const open = view({ stage: "executed", spec: { kind: "open", venueId: "morpho-blue", asset: "ETH", amount: 1, borrow: 1000, safeId: "x", network: "base" } as never });
    expect(open.doneLine).toBe("Done. $1,000 USDC is now in your Safe.");
    expect(view({ stage: "executed", spec: { kind: "close", loanId: "a" } as never }).doneLine).toBe("Done. Executed in Safe.");
    expect(view().doneLine).toBeUndefined();
  });
  it("labels stored repayment balances as estimates after execution", () => {
    const executed = view({ stage: "executed", spec: { kind: "repay", loanId: "8453:0xabc:morpho-blue", amount: 200, owed: 1000 } as never });
    expect(executed.facts?.terms).toContainEqual(expect.objectContaining({ label: "Debt when proposed", value: "1,000 USDC" }));
    expect(executed.facts?.terms).toContainEqual(expect.objectContaining({ label: "Estimated after repayment", value: "about 800 USDC" }));
    expect(executed.facts?.terms).not.toContainEqual(expect.objectContaining({ label: "Owed now" }));
    expect(executed.facts?.numbers).toContainEqual({ value: "200 USDC", label: "Requested repayment" });
    expect(executed.facts?.numbers).toContainEqual({ value: "800 USDC", label: "Estimated still owed" });
    expect(executed.doneLine).toBe("Done. Your repayment transaction ran on your Morpho loan. Check the loan for its updated balance.");
  });
  it("does not promise the loan remains safe in visible approval copy", () => {
    const open = view({
      spec: { kind: "open", venueId: "morpho-blue", asset: "ETH", amount: 1, borrow: 1000, safeId: "x", network: "base" } as never,
      outcome: "Interest per year: $29 at 2.9%. The lender could sell some of your ETH if its price falls to about $1,874 (32% below today's $2,745).",
    });
    expect(open.facts?.healthLine).toBe("The lender could sell some of this collateral if its price falls below the liquidation price shown above.");
    expect(open.facts?.healthLine).not.toMatch(/stays safe|will alert/i);
  });
  it("says what each stage means", () => {
    expect(view({ stage: "draft", tx: null, safeTxHash: null }).sentence).toBe("Drafted, not yet sent to Safe.");
    expect(view().sentence).toBe("In your Safe queue. Needs 2 signatures.");
    expect(view({}, 1).sentence).toBe("In your Safe queue. Needs 1 signature.");
    const part = view({ confirmations: [conf(MOCK_OWNER)] }, 3);
    expect(part.sentence).toBe("1 of 3 signed. Needs 2 more signatures.");
    expect(part).toMatchObject({ needsSignatures: 2, signedCount: 1 });
    expect(view({ confirmations: [conf(MOCK_OWNER)] }).sentence).toBe("1 of 2 signed. Needs 1 more signature.");
    expect(view({ confirmations: [conf(MOCK_OWNER)] }, 1).sentence).toBe("Signed. Waiting for execution in Safe.");
    expect(view({ stage: "executed" }).sentence).toBe("Done. Executed in Safe.");
    expect(view({ stage: "failed" }).sentence).toBe("It did not go through when it ran in Safe. Nothing in your Safe changed.");
    expect(view({ stage: "not_sent", safeTxHash: null }).sentence).toMatch(/not sent/i);
    expect(view({ stage: "rejected", tx: null, safeTxHash: null }).sentence).toBe("Rejected. Nothing was sent.");
    expect(view({ stage: "stale", tx: null, safeTxHash: null }).sentence).toBe("Out of date: the loan changed. Nothing was sent.");
  });
  it("says a rejected proposal is still in the queue, with Open in Safe", () => {
    const v = view({ stage: "rejected" });
    expect(v.sentence).toBe("Rejected here. It is still in your Safe queue. Reject it in Safe too.");
    expect(v.inSafe).toBe(true);
    expect(view({ stage: "rejected", deletedFromQueue: true }).sentence).toBe("Rejected. Nothing was sent.");
    expect(view({ stage: "stale" }).sentence).toBe("Out of date: the loan changed. It is still in your Safe queue. Reject it in Safe too.");
    expect(view({ stage: "stopped" }).sentence).toMatch(/still in your Safe queue/);
    expect(view({ stage: "replaced" }).stillQueuedNote).toBeDefined();
  });
  it("recomputes the hash and flags a stored one that differs", () => {
    expect(view().safeTxHash).toBe(hash);
    expect(view().hashMismatch).toBe(false);
    const bad = view({ safeTxHash: `0x${"ab".repeat(32)}` });
    expect(bad).toMatchObject({ safeTxHash: hash, hashMismatch: true });
  });
  it("links to the transaction, and the queue as the fallback", () => {
    expect(view().links).toEqual({ tx: safeTxLink(8453, MOCK_SAFE, hash), queue: safeQueueLink(8453, MOCK_SAFE) });
    expect(view({ stage: "draft", tx: null, safeTxHash: null })).toMatchObject({ safeTxHash: null, links: { tx: null } });
  });
  it("carries the stored text, nonce and whether the viewer signed", () => {
    const v = view({ confirmations: [conf(MOCK_COSIGNER.toLowerCase())], testRun: { ok: true, line: "Checked: this would work." } });
    expect(v).toMatchObject({ title: "Protect Aave loan", steps: ["a", "b"], outcome: "Uses 1 ETH.", nonce: "7", viewerSigned: true, testRunLine: "Checked: this would work.", final: false });
  });
  it("tells the viewer what to do next while queued", () => {
    expect(view().nextStep).toBe("Your signature is needed. Open Safe, check that the code below matches, then sign.");
    expect(view({ confirmations: [conf(MOCK_COSIGNER.toLowerCase())] }).nextStep).toBe("You signed. Waiting for the other owner.");
    expect(view({ confirmations: [conf(MOCK_COSIGNER.toLowerCase())] }, 3).nextStep).toBe("You signed. Waiting for 2 more owners.");
    expect(view({ confirmations: [conf(MOCK_OWNER), conf(MOCK_COSIGNER)] }).nextStep).toBe("All signatures are in. One of you now opens Safe and presses Execute.");
    expect(view({ safeTxHash: `0x${"ab".repeat(32)}` }).nextStep).toBeUndefined();
    expect(view({ stage: "executed" }).nextStep).toBeUndefined();
  });
  it("exposes the spec kind, the loan id and the replacement", () => {
    expect(view({ stage: "replaced", replacedBy: "p2" })).toMatchObject({ replacedBy: "p2", specKind: "unknown" });
    expect(view({ replacedBy: "p2" }).replacedBy).toBeUndefined();
    const open = view({ spec: { kind: "open", venueId: "morpho-blue" } as never });
    expect(open).toMatchObject({ specKind: "open", loanId: `8453:${MOCK_SAFE.toLowerCase()}:morpho-blue` });
    expect(view({ spec: { kind: "close", loanId: "8453:0xabc:aave-v3" } as never }).loanId).toBe("8453:0xabc:aave-v3");
    expect(view({ spec: { kind: "reserve-off" } as never }).loanId).toBeUndefined();
  });
});

describe("proposalView sign state", () => {
  const A = MOCK_OWNER, B = MOCK_COSIGNER;
  const v = (o: Partial<ProposalRow>, chain: Parameters<typeof proposalView>[1]["chain"], viewer = A) =>
    proposalView(row(o), { viewer, threshold: 2, safeAddress: MOCK_SAFE, chain });
  const facts = { owners: [A, B], nonce: 7n };

  it("needs_your_signature, then waiting_for_others once you signed, then ready_to_send", () => {
    expect(v({}, facts)).toMatchObject({ state: "needs_your_signature", canSign: true, canSend: false, threshold: 2 });
    expect(v({ confirmations: [conf(A)] }, facts)).toMatchObject({ state: "waiting_for_others", canSign: false, canSend: false });
    expect(v({ confirmations: [conf(A), conf(B)] }, facts)).toMatchObject({ state: "ready_to_send", canSign: false, canSend: true });
  });
  it("the last signer can sign and send in one step", () => {
    expect(v({ confirmations: [conf(B)] }, facts)).toMatchObject({ state: "needs_your_signature", canSign: true, canSend: true });
  });
  it("a non-owner sees state but can neither sign nor send", () => {
    const x = v({ confirmations: [conf(A), conf(B)] }, facts, "0x90F79bf6EB2c4f870365E785982E1f101E93b906");
    expect(x).toMatchObject({ state: "ready_to_send", canSign: false, canSend: false });
    expect(x.owners?.every((o) => !o.isYou)).toBe(true);
  });
  it("blocked, out_of_date, sending, executed, failed, rejected", () => {
    expect(v({}, { owners: [A, B], nonce: 5n, blockedBy: [{ id: "p0", nonce: "5", title: "t" }] })).toMatchObject({ state: "blocked", canSend: false, blockedBy: [{ id: "p0", nonce: "5", title: "t" }] });
    expect(v({}, { owners: [A, B], nonce: 8n })).toMatchObject({ state: "settling", canSign: false, canSend: false, stage: "queued" });
    expect(v({ testRun: { pendingExec: { txHash: `0x${"11".repeat(32)}`, at: new Date().toISOString(), by: A } } }, { owners: [A, B], nonce: 8n })).toMatchObject({ state: "sending", canSend: false });
    expect(v({ stage: "executed" }, undefined).state).toBe("executed");
    expect(v({ stage: "failed" }, undefined)).toMatchObject({ state: "failed", failedReason: expect.any(String) });
    expect(v({ stage: "stale" }, undefined).state).toBe("out_of_date");
    for (const stage of ["rejected", "stopped", "replaced", "not_sent"] as const) expect(v({ stage }, undefined).state).toBe("rejected");
    expect(v({ stage: "draft" }, undefined).state).toBeNull();
  });
  it("reports nonce expiry separately from queue presence and preserves unavailable reads", () => {
    expect(v({ stage: "stale" }, { owners: null, nonce: 8n })).toMatchObject({ inSafe: true, noncePassed: true });
    expect(v({ stage: "stale" }, { owners: null, nonce: 7n })).toMatchObject({ inSafe: true, noncePassed: false });
    expect(v({ stage: "stale" }, { owners: null, nonce: null })).toMatchObject({ inSafe: true, noncePassed: null });
  });
  it("offers nothing when the owners could not be read, or the hash does not match", () => {
    expect(v({}, { owners: null, nonce: 7n })).toMatchObject({ canSign: false, canSend: false });
    expect(v({ safeTxHash: `0x${"ab".repeat(32)}` }, facts)).toMatchObject({ canSign: false, canSend: false });
  });
});

describe("what the page can show after the run", () => {
  const txHash = `0x${"cd".repeat(32)}`;
  it("carries the stored execution hash, the time and who approved", () => {
    const v = view({ stage: "executed", executedTxHash: txHash, updatedAt: new Date("2026-01-01T00:05:00Z"), confirmations: [conf(MOCK_OWNER), conf(MOCK_COSIGNER)] });
    expect(v.executionTxHash).toBe(txHash);
    expect(v.executedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(v.approvals).toEqual([{ address: MOCK_OWNER, at: "2026-01-01T00:00:00Z", isYou: false }, { address: MOCK_COSIGNER, at: "2026-01-01T00:00:00Z", isYou: true }]);
    expect(v.target).toBe(tx.to);
  });
  it("has no execution hash before it runs", () => {
    const v = view({ stage: "queued" });
    expect(v.executionTxHash).toBeUndefined();
    expect(v.executedAt).toBeUndefined();
  });
});

describe("calls and safety", () => {
  it("lists the calls of the stored transaction", async () => {
    const { buildSafeTx } = await import("@/server/safe/multisend");
    const batch = buildSafeTx([{ to: "0x4200000000000000000000000000000000000006", data: "0x095ea7b3" }, { to: "0x3333333333333333333333333333333333333333" }], 7);
    const v = view({ tx: batch, safeTxHash: safeTxHash(8453, MOCK_SAFE, batch) });
    expect(v.calls.map((c) => [c.name, c.fn])).toEqual([["MultiSendCallOnly", "multiSend"], ["WETH", "approve"], [null, null]]);
  });
  it("has no calls before a transaction is stored", () => {
    expect(view({ tx: null, safeTxHash: null }).calls).toEqual([]);
  });
  it("names the safety level from the stored spec, and shows nothing for older proposals", () => {
    expect(view({ spec: { kind: "open", hfIdx: 0 } }).safety).toBe("Extra safe");
    expect(view({ spec: { kind: "open", hfIdx: 1 } }).safety).toBe("Balanced");
    expect(view({ spec: { kind: "open", hfIdx: 2 } }).safety).toBe("Lean");
    expect(view({ spec: { kind: "open" } }).safety).toBeUndefined();
    expect(view({ spec: { kind: "close", hfIdx: 1 } }).safety).toBeUndefined();
  });
});
