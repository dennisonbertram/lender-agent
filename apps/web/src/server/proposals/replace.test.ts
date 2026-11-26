import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activity, proposals, safeNetworks } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import type { ChainId, Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { sendLive } from "../../../tests/helpers/live-send";
import { planDrafts } from "@/server/db/schema";
import { replaceProposal, sendPlan } from "./replace";
import { confirmProposal } from "./sign";
import { safeTxTypedData } from "@/server/safe/hash";
import type { SafeTx } from "@/shared/types";
import { nextNonce, reconcileSending, sendToSafe, sendToSafeLocked } from "./send";
import { proposalView } from "./view";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;
const ownerAcct = () => privateKeyToAccount(MOCK_OWNER_KEY);
const fake = () => w.services.fakes.get(8453)!;
const body = (draftKey: string, cash: number) => ({ draftKey, chainId: 8453 as const, cash, hfIdx: 1 as const });
const setLive = (draftKey: string, cash: number) =>
  w.db.insert(planDrafts).values({ safeId, draft: { text: `$${cash}`, hfIdx: 1, months: 12, cash, msgId: "m1", draftKey, seen: ["m1"] } })
    .onConflictDoUpdate({ target: planDrafts.safeId, set: { draft: { text: `$${cash}`, hfIdx: 1, months: 12, cash, msgId: "m1", draftKey, seen: ["m1"] } } });
const byId = async (id: string) => (await w.db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
const acts = () => w.db.select().from(activity).where(eq(activity.safeId, safeId));

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => { vi.restoreAllMocks(); w.reset(); });

describe("replaceProposal (BP-24)", () => {
  it("an unconfirmed queued proposal is deleted from the queue (signed DeleteRequest) and the new one is queued; the old card reads Replaced", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const old = await byId(first.proposalId);
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 1500);
    const r = await replaceProposal(ctx, first.proposalId, body("d2", 1500));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await fake().getMultisigTransaction(old.safeTxHash as Hex)).toBeNull();
    expect(r.stage).toBe("queued");
    expect(r.proposalId).not.toBe(first.proposalId);
    const after = await byId(first.proposalId);
    expect(after).toMatchObject({ stage: "replaced", deletedFromQueue: true, replacedBy: r.proposalId });
    const view = proposalView(after, { viewer: MOCK_OWNER, threshold: 2, safeAddress: SAFE });
    expect(view.sentence).toBe("Replaced by a newer plan.");
    expect(view.stillQueuedNote).toBeUndefined();
    const neu = await byId(r.proposalId);
    expect(neu.nonce).toBe(old.nonce); // takes the freed place in the queue
    expect(neu.title).not.toBe(old.title);
    const log = await acts();
    expect(log.some((a) => a.text === `Updated draft: ${neu.title}`)).toBe(true);
    expect(log.some((a) => a.actor === "Agent" && /deleted/.test(a.text))).toBe(true);
  });

  it("an owner-confirmed one is never deleted: the new proposal competes at its nonce and the old card says it is still in Safe", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const old = await byId(first.proposalId);
    fake().confirm(old.safeTxHash as Hex, MOCK_COSIGNER);
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 1500);
    const r = await replaceProposal(ctx, first.proposalId, body("d2", 1500));
    expect(spy).not.toHaveBeenCalled();
    expect(await fake().getMultisigTransaction(old.safeTxHash as Hex)).not.toBeNull();
    const after = await byId(first.proposalId);
    expect(after).toMatchObject({ stage: "replaced", deletedFromQueue: false });
    const view = proposalView(after, { viewer: MOCK_OWNER, threshold: 2, safeAddress: SAFE });
    expect(view.stillQueuedNote).toMatch(/^Still in your Safe queue\. Reject it in Safe too\./);
    expect(view.inSafe).toBe(true);
    const neu = await byId(r.proposalId);
    expect(neu.nonce).toBe(old.nonce); // the same nonce: they compete, only one can execute
    expect(neu.safeTxHash).not.toBe(old.safeTxHash);
    expect(view.stillQueuedNote).toMatch(/does not cancel it/);
    // Once either executes the Safe nonce moves past both: the other can never run.
    await w.services.fixture.setNonce(8453, SAFE, old.nonce! + 1n);
    const onChain = (await w.services.reader.readSafeNonce(8453, SAFE))!;
    expect(onChain).toBeGreaterThan(old.nonce!);
    expect(onChain).toBeGreaterThan(neu.nonce!);
    // ...and the next ordinary proposal goes after, with no extra proposal at the shared nonce
    const next = await nextNonce(w.db, w.services, safeId, 8453, SAFE);
    expect(next).toBe(onChain);
  });

  it("an unconfirmed original deleted with a later proposal queued: the replacement takes the original's nonce, leaving no gap", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const second = await sendLive(ctx, body("d3", 1000));
    const [o1, o2] = [await byId(first.proposalId), await byId(second.proposalId)];
    expect(o2.nonce).toBe(o1.nonce! + 1n);
    await setLive("d2", 1500);
    const r = await replaceProposal(ctx, first.proposalId, body("d2", 1500));
    expect((await byId(r.proposalId)).nonce).toBe(o1.nonce);
    expect((await byId(second.proposalId)).nonce).toBe(o2.nonce);
  });

  it("a refused delete leaves it in the queue and says so", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    vi.spyOn(fake(), "deleteTransaction").mockRejectedValue(new Error("refused"));
    await setLive("d2", 1500);
    await replaceProposal(ctx, first.proposalId, body("d2", 1500));
    expect(await byId(first.proposalId)).toMatchObject({ stage: "replaced", deletedFromQueue: false });
  });

  it("a draft (nothing sent) is replaced without a delete call", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    await w.db.update(proposals).set({ stage: "draft", safeTxHash: null }).where(eq(proposals.id, first.proposalId));
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 1500);
    await replaceProposal(ctx, first.proposalId, body("d2", 1500));
    expect(spy).not.toHaveBeenCalled();
    expect((await byId(first.proposalId)).stage).toBe("replaced");
  });

  it("one that already ran in Safe, or is not open, cannot be replaced (409) and nothing is deleted", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const old = await byId(first.proposalId);
    fake().markExecuted(old.safeTxHash as Hex, { success: true, txHash: `0x${"11".repeat(32)}` });
    const spy = vi.spyOn(fake(), "deleteTransaction");
    const propose = vi.spyOn(fake(), "proposeTransaction");
    await setLive("d2", 1500);
    await expect(replaceProposal(ctx, first.proposalId, body("d2", 1500))).rejects.toMatchObject({ status: 409 });
    expect(propose).not.toHaveBeenCalled();
    const replacement = (await w.db.select().from(proposals)).find((row) => row.id !== first.proposalId);
    expect(replacement).toMatchObject({ stage: "not_sent", submissionAttemptedAt: null });
    expect(await byId(first.proposalId)).toMatchObject({ stage: "executed", replacedBy: null });
    await expect(replaceProposal(ctx, first.proposalId, body("d2", 1500))).rejects.toMatchObject({ status: 409 });
    expect(spy).not.toHaveBeenCalled();
    expect(await w.db.select().from(proposals)).toHaveLength(2);
  });

  it("if the new plan is blocked, the old proposal is not touched (checked before anything is deleted)", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 999_999_999);
    await expect(replaceProposal(ctx, first.proposalId, body("d2", 999_999_999))).rejects.toMatchObject({ status: 422 });
    expect(spy).not.toHaveBeenCalled();
    expect((await byId(first.proposalId)).stage).toBe("queued");
  });

  it("an edit that leaves the transaction unchanged changes nothing and returns the existing proposal", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 2000);
    const r = await replaceProposal(ctx, first.proposalId, { ...body("d2", 2000), months: 24 });
    expect(r).toMatchObject({ proposalId: first.proposalId, unchanged: true });
    expect(r.receipt).toMatch(/already in your Safe queue/);
    expect(spy).not.toHaveBeenCalled();
    expect(await byId(first.proposalId)).toMatchObject({ stage: "queued", replacedBy: null });
    expect(await w.db.select().from(proposals)).toHaveLength(1);
  });

  it("holds the Safe-wide send lock while replacing so another network cannot store a concurrent sending loan", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    await w.db.insert(safeNetworks).values({ safeId, chainId: 42161, deployed: true, agentAdded: true });
    w.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_OWNER], 1);
    w.services.fixture.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    w.services.fakes.get(42161)!.setOwners(SAFE, [MOCK_OWNER], 1);
    const arbSignature: Hex = await ownerAcct().signTypedData(delegateTypedData(42161, w.services.signer.address));
    await w.services.fakes.get(42161)!.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: arbSignature });
    const both = { ...ctx, access: { ...ctx.access, ownedChainIds: [8453, 42161] as ChainId[], trackedChainIds: [8453, 42161] as ChainId[], chat: true, ownersDiffer: false } };

    let entered!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const holdDelete = new Promise<void>((resolve) => { release = resolve; });
    const realDelete = fake().deleteTransaction.bind(fake());
    vi.spyOn(fake(), "deleteTransaction").mockImplementation(async (...args) => {
      entered();
      await holdDelete;
      return realDelete(...args);
    });

    await setLive("replacement", 1500);
    const replacing = replaceProposal(ctx, first.proposalId, body("replacement", 1500));
    const replacementOutcome = replacing.then((value) => ({ value }), (error) => ({ error }));
    const cleanupStarted = await Promise.race([deleteStarted.then(() => true), replacementOutcome.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
    if (!cleanupStarted) {
      release();
      const outcome = await replacementOutcome;
      throw new Error(`Replacement did not enter cleanup: ${"error" in outcome ? String(outcome.error) : JSON.stringify(outcome.value)}`);
    }
    const arbService = w.services.fakes.get(42161)!;
    const otherPropose = vi.spyOn(arbService, "proposeTransaction");
    // Bypass the in-process queue: the durable database reservation must block another worker too.
    const otherSend = sendToSafeLocked(both, { draftKey: "replacement", chainId: 42161, cash: 1500, hfIdx: 1 }).then(
      () => null,
      (error: unknown) => error,
    );
    let otherResult: unknown;
    let oldWhileCleanup: Awaited<ReturnType<typeof byId>>;
    let rowsWhileCleanup: Array<typeof proposals.$inferSelect>;
    let proposedWhileCleanup = false;
    try {
      otherResult = await Promise.race([
        otherSend,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
      oldWhileCleanup = await byId(first.proposalId);
      rowsWhileCleanup = await w.db.select().from(proposals);
      proposedWhileCleanup = otherPropose.mock.calls.length > 0;
    } finally {
      // Always unblock replacement, including when an assertion fails, so Vitest can report the failure.
      release();
    }
    const replaced = await replacing;
    expect(otherResult).toMatchObject({ status: 409, message: expect.stringMatching(/still being sent|already sent on another network/i) });
    expect(oldWhileCleanup!).toMatchObject({ stage: "queued", replacedBy: expect.any(String), deletedFromQueue: false });
    expect(rowsWhileCleanup!.some((row) => row.stage === "sending" && row.chainId === 8453)).toBe(true);
    expect(proposedWhileCleanup).toBe(false);
    expect(replaced.oldStillInSafe).toBe(false);
    expect(replaced.stage).toBe("queued");
    expect(await w.db.select().from(proposals)).toHaveLength(2);
    expect((await w.db.select().from(proposals)).filter((p) => p.stage === "sending")).toHaveLength(0);
  });

  it("worker reconciliation completes original cleanup before delivering a replacement after request interruption", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const original = await byId(first.proposalId);
    await setLive("resume-replacement", 1500);
    const deleteSpy = vi.spyOn(fake(), "deleteTransaction");
    const propose = vi.spyOn(fake(), "proposeTransaction");

    await expect(sendToSafeLocked(ctx, body("resume-replacement", 1500), {
      nonce: original.nonce!, original, afterStore: async () => { throw new Error("request stopped after reservation commit"); },
    })).rejects.toThrow("request stopped after reservation commit");

    const replacement = (await w.db.select().from(proposals)).find((row) => row.id !== original.id)!;
    expect(await byId(original.id)).toMatchObject({ stage: "queued", replacedBy: replacement.id, deletedFromQueue: false });
    expect(replacement).toMatchObject({ stage: "sending", submissionAttemptedAt: null, nonce: original.nonce });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();

    const resumed = await reconcileSending(ctx, replacement.id);
    expect(resumed.stage).toBe("queued");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(await byId(original.id)).toMatchObject({ stage: "replaced", deletedFromQueue: true, replacedBy: replacement.id });
    expect(await fake().getMultisigTransaction(original.safeTxHash as Hex)).toBeNull();
  });

  it("a stranger's proposal id is 404", async () => {
    await expect(replaceProposal(ctx, "nope", body("d2", 1500))).rejects.toMatchObject({ status: 404 });
  });

  it("a failing threshold read blocks the replace before anything is deleted", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 1500);
    vi.spyOn(w.services.reader, "readSafeThreshold").mockRejectedValue(new Error("rpc down"));
    await expect(replaceProposal(ctx, first.proposalId, body("d2", 1500))).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect((await byId(first.proposalId)).stage).toBe("queued");
  });

  it("a reservation transaction failure leaves the original untouched and a retry replaces it at the same nonce", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const old = await byId(first.proposalId);
    await setLive("d2", 1500);
    const deletes = vi.spyOn(fake(), "deleteTransaction");
    vi.spyOn(w.db, "transaction").mockRejectedValue(new Error("db down"));
    await expect(replaceProposal(ctx, first.proposalId, body("d2", 1500))).rejects.toThrow("db down");
    vi.restoreAllMocks();
    expect(deletes).not.toHaveBeenCalled();
    expect(await byId(first.proposalId)).toMatchObject({ stage: "queued", deletedFromQueue: false, replacedBy: null });
    const again = await replaceProposal(ctx, first.proposalId, body("d2", 1500));
    expect((await byId(again.proposalId)).nonce).toBe(old.nonce);
    expect((await byId(first.proposalId)).replacedBy).toBe(again.proposalId);
  });
});

describe("sendPlan: a new plan for the same Safe replaces the earlier unexecuted one", () => {
  it("replaces the first: same nonce, old deleted and replaced, old confirm 409, new one not blocked", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const old = await byId(first.proposalId);
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 1500);
    const r = await sendPlan(ctx, body("d2", 1500));
    expect(r.stage).toBe("queued");
    expect(spy).toHaveBeenCalledTimes(1);
    const after = await byId(first.proposalId);
    expect(after).toMatchObject({ stage: "replaced", deletedFromQueue: true, replacedBy: r.proposalId });
    const neu = await byId(r.proposalId);
    expect(neu.nonce).toBe(old.nonce);
    const sig = await ownerAcct().signTypedData(safeTxTypedData(8453, SAFE, old.tx as SafeTx));
    await expect(confirmProposal(ctx, first.proposalId, sig)).rejects.toMatchObject({ status: 409 });
    const view = proposalView(after, { viewer: MOCK_OWNER, threshold: 2, safeAddress: SAFE });
    expect(view.state === "blocked").toBe(false);
    expect(view.sentence).toBe("Replaced by a newer plan.");
    expect(view.replacedBy).toBe(r.proposalId);
    const newView = proposalView(neu, { viewer: MOCK_OWNER, threshold: 2, safeAddress: SAFE });
    expect(newView.blockedBy).toBeUndefined();
  });

  it("an old plan with an owner confirmation keeps its queue entry but the new one reuses its nonce and the old is replaced", async () => {
    const first = await sendLive(ctx, body("d1", 2000));
    const old = await byId(first.proposalId);
    fake().confirm(old.safeTxHash as Hex, MOCK_COSIGNER);
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await setLive("d2", 1500);
    const r = await sendPlan(ctx, body("d2", 1500));
    expect(spy).not.toHaveBeenCalled();
    expect((await byId(first.proposalId))).toMatchObject({ stage: "replaced", deletedFromQueue: false });
    expect((await byId(r.proposalId)).nonce).toBe(old.nonce);
  });

  it("pressing the same plan twice is one proposal, not a self-replacement", async () => {
    await setLive("d1", 2000);
    const a = await sendPlan(ctx, body("d1", 2000));
    const b = await sendPlan(ctx, body("d1", 2000));
    expect(b.proposalId).toBe(a.proposalId);
    expect((await byId(a.proposalId)).stage).toBe("queued");
  });

  it("an earlier plan still 'sending' that the service has is reconciled and replaced at its nonce", async () => {
    const real = fake().proposeTransaction.bind(fake());
    const lookup = vi.spyOn(fake(), "getMultisigTransaction");
    vi.spyOn(fake(), "proposeTransaction").mockImplementationOnce(async (p) => {
      await real(p);
      // Safe accepted the POST but its lookup has not caught up when Send first polls.
      lookup.mockResolvedValueOnce(null);
      throw new TypeError("fetch failed");
    });
    await setLive("d1", 2000);
    const a = await sendPlan(ctx, body("d1", 2000));
    expect(a.stage).toBe("sending");
    const old = await byId(a.proposalId);
    await setLive("d2", 1500);
    const r = await sendPlan(ctx, body("d2", 1500));
    expect(r.stage).toBe("queued");
    expect((await byId(a.proposalId)).stage).toBe("replaced");
    expect((await byId(r.proposalId)).nonce).toBe(old.nonce);
  });

  it("an earlier plan whose delivery is unresolved blocks a new plan: 409, no new nonce", async () => {
    vi.spyOn(fake(), "proposeTransaction").mockRejectedValue(new TypeError("fetch failed"));
    vi.spyOn(fake(), "getMultisigTransaction").mockRejectedValue(new TypeError("fetch failed"));
    await setLive("d1", 2000);
    const a = await sendPlan(ctx, body("d1", 2000));
    expect(a.stage).toBe("sending");
    await setLive("d2", 1500);
    await expect(sendPlan(ctx, body("d2", 1500))).rejects.toMatchObject({ status: 409, message: "An earlier plan is still being sent. Try again in a moment." });
    expect(await w.db.select().from(proposals).where(eq(proposals.safeId, safeId))).toHaveLength(1);
  });

  it("with nothing earlier open it is an ordinary send", async () => {
    await setLive("d1", 2000);
    const a = await sendPlan(ctx, body("d1", 2000));
    expect(a.stage).toBe("queued");
  });
});
