import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { randomUUID } from "node:crypto";
import { activity, proposals, safeNetworks } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { SafeServiceError } from "@/server/safe/service-client";
import { safeContext } from "@/server/request";
import { HttpError } from "@/server/http";
import type { ChainId, Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { planDrafts } from "@/server/db/schema";
import { mockExecute } from "@/server/mock/safe-wallet";
import { quotePlan } from "@/server/quote";
import { refreshProposal } from "./follow";
import { nextNonce, reconcileAllSending, reconcileSending, sentReceiptOf, sendToSafe as send, withNextProposalNonce, SendBlocked } from "./send";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;

/** Unless a test sets its own draft, the key being sent is the Safe's live draft (the card the user pressed). */
let autoLive = true;
const setLive = (draftKey: string, msgId = "m1") =>
  w.db.insert(planDrafts).values({ safeId, draft: { text: "$2,000", hfIdx: 1, months: 12, cash: 2000, msgId, draftKey, seen: [msgId] } })
    .onConflictDoUpdate({ target: planDrafts.safeId, set: { draft: { text: "$2,000", hfIdx: 1, months: 12, cash: 2000, msgId, draftKey, seen: [msgId] } } });
const sendToSafe: typeof send = async (c, b) => { if (autoLive) await setLive(b.draftKey); return send(c, b); };

const fake = () => w.services.fakes.get(8453)!;
const body = (draftKey = "d1", extra: object = {}) => ({ draftKey, chainId: 8453 as const, cash: 2000, hfIdx: 1 as const, ...extra });
const rows = () => w.db.select().from(proposals);

async function addAgent() {
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
}

beforeEach(async () => {
  autoLive = true;
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  await addAgent();
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => { vi.restoreAllMocks(); w.reset(); });

describe("sendToSafe", () => {
  it("a chosen lender is never switched: Compound's $100 minimum refuses $20 instead of building Compound's tx from Aave's quote", async () => {
    autoLive = false;
    const qctx = { db: w.db, services: w.services, safe: { id: safeId, address: MOCK_SAFE } };
    // The plan card's quote switched lender (no venueChosen): the draft is live, the Send must not follow it.
    const q = await quotePlan(qctx, { cash: 20, venueId: "compound-v3", messageId: "m9" });
    expect(q.venueId).not.toBe("compound-v3");
    await expect(send(ctx, body(q.draft.draftKey!, { cash: 20, venueId: "compound-v3", venueChosen: true }))).rejects.toMatchObject({ message: expect.stringMatching(/smallest Compound v3 loan is \$100/) });
    await expect(send(ctx, body(q.draft.draftKey!, { cash: 20, venueId: "compound-v3" }))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Compound v3/) });
    expect(await rows()).toHaveLength(0);
  });

  it("a sizing answer's draft key cannot be sent: 409, nothing queued", async () => {
    autoLive = false;
    const q = await quotePlan({ db: w.db, services: w.services, safe: { id: safeId, address: MOCK_SAFE } }, { cash: 2000, hypothetical: true, messageId: "hyp1" });
    expect(q.draft.draftKey).toBeTruthy();
    await expect(send(ctx, body(q.draft.draftKey!))).rejects.toMatchObject({ status: 409, message: "A sizing answer can't be sent. Plan a loan you can afford." });
    expect(await rows()).toHaveLength(0);
  });

  it("puts one proposal in the queue, proposed by the agent, with an Activity row", async () => {
    const r = await sendToSafe(ctx, body());
    expect(r.stage).toBe("queued");
    expect(r.receipt).toMatch(/^Sent to your Safe: borrow \$2,000/);
    const [row] = await rows();
    const live = await fake().getMultisigTransaction(row.safeTxHash as Hex);
    expect(live?.proposedByDelegate?.toLowerCase()).toBe(w.services.signer.address.toLowerCase());
    const acts = await w.db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ actor: "Agent", kind: "proposed" });
    expect(acts[0].detail).not.toMatch(/Allow/);
  });

  it("two presses with one draftKey make one proposal and one service call", async () => {
    const spy = vi.spyOn(fake(), "proposeTransaction");
    const a = await sendToSafe(ctx, body());
    const b = await sendToSafe(ctx, body());
    expect(b.proposalId).toBe(a.proposalId);
    expect(await rows()).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("blocks a second-chain send while a loan proposal for the Safe is still sending, even after a fresh draft", async () => {
    autoLive = false;
    await w.db.insert(safeNetworks).values({ safeId, chainId: 42161, deployed: true, agentAdded: true });
    w.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_OWNER], 1);
    w.services.fixture.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    w.services.fakes.get(42161)!.setOwners(SAFE, [MOCK_OWNER], 1);
    const arbSignature: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(42161, w.services.signer.address));
    await w.services.fakes.get(42161)!.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: arbSignature });
    const both = { ...ctx, access: { ...ctx.access, ownedChainIds: [8453, 42161] as ChainId[], trackedChainIds: [8453, 42161] as ChainId[], chat: true, ownersDiffer: false } };
    await setLive("shared-draft");
    vi.spyOn(w.services.fakes.get(42161)!, "proposeTransaction").mockRejectedValue(new TypeError("fetch failed"));
    const first = await send(both, { ...body("shared-draft"), chainId: 42161 });
    expect(first.stage).toBe("sending");
    const baseProposal = vi.spyOn(fake(), "proposeTransaction");
    await expect(send(both, { ...body("shared-draft"), chainId: 8453 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still being sent|already sent on another network/i) });
    await setLive("fresh-after-reload", "m2");
    const reopened = await quotePlan({ db: w.db, services: w.services, safe: { id: safeId, address: MOCK_SAFE }, ownedChainIds: [8453, 42161] }, { cash: 2000, messageId: "m3" });
    expect(reopened.draft.pendingSend).toBe(true);
    await expect(send(both, { ...body("fresh-after-reload"), chainId: 8453 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still being sent/i) });
    expect(baseProposal).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);

    // Close/fix/move/setup callers use the allocator without the open-loan-only exclusion.
    const close = await withNextProposalNonce(w.db, safeId, 8453, 0n, async (storage, nonce) => {
      const [row] = await storage.insert(proposals).values({
        id: randomUUID(), safeId, chainId: 8453, spec: { kind: "close", loanId: "test:existing-position" },
        tx: { to: SAFE, value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: nonce.toString() },
        nonce, safeTxHash: `0x${"44".repeat(32)}`, idempotencyKey: "test:close-pending-open",
        title: "Close existing loan", steps: [], outcome: "Repay existing loan.", stage: "sending", testRun: { ok: true }, createdBy: MOCK_OWNER.toLowerCase(),
      }).returning();
      return row;
    });
    expect(close).toMatchObject({ stage: "sending", nonce: 0n, chainId: 8453 });
    expect(await rows()).toHaveLength(2);
  });

  it("allows the same draft on another network after a definitive not-sent refusal", async () => {
    autoLive = false;
    await w.db.insert(safeNetworks).values({ safeId, chainId: 42161, deployed: true, agentAdded: true });
    w.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_OWNER], 1);
    w.services.fixture.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    w.services.fakes.get(42161)!.setOwners(SAFE, [MOCK_OWNER], 1);
    const arbSignature: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(42161, w.services.signer.address));
    await w.services.fakes.get(42161)!.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: arbSignature });
    const both = { ...ctx, access: { ...ctx.access, ownedChainIds: [8453, 42161] as ChainId[], trackedChainIds: [8453, 42161] as ChainId[], chat: true, ownersDiffer: false } };
    await setLive("refused-cross-network-plan");
    vi.spyOn(w.services.fakes.get(42161)!, "proposeTransaction").mockRejectedValue(new SafeServiceError(422, { detail: "Definitive refusal" }));

    const refused = await send(both, { ...body("refused-cross-network-plan"), chainId: 42161 });
    expect(refused.stage).toBe("not_sent");
    const refusedRow = (await rows()).find((row) => row.id === refused.proposalId);
    expect(refusedRow).toMatchObject({ chainId: 42161, stage: "not_sent", submissionAttemptedAt: expect.any(Date) });

    const accepted = await send(both, { ...body("refused-cross-network-plan"), chainId: 8453 });
    expect(accepted.stage).toBe("queued");
    expect((await rows()).find((row) => row.id === accepted.proposalId)).toMatchObject({ chainId: 8453, stage: "queued" });
  });

  it("stores the record and our hash before the signer is called", async () => {
    const real = w.services.signer.signProposal.bind(w.services.signer);
    let seen: typeof proposals.$inferSelect[] = [];
    vi.spyOn(w.services.signer, "signProposal").mockImplementation(async (p) => {
      seen = await rows();
      return real(p);
    });
    await sendToSafe(ctx, body());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ stage: "sending" });
    expect(seen[0].safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(seen[0].tx).toBeTruthy();
    expect(seen[0].nonce).toBe(0n);
  });

  it("numbers a second proposal after the first still-open one", async () => {
    await sendToSafe(ctx, body("a"));
    await sendToSafe(ctx, body("b", { cash: 1500 }));
    expect((await rows()).map((r) => r.nonce).sort()).toEqual([0n, 1n]);
  });

  it("settles a definitive POST refusal after confirming the hash is absent", async () => {
    vi.spyOn(fake(), "proposeTransaction").mockRejectedValue(new SafeServiceError(422, { nonFieldErrors: ["nope"] }));
    const r = await sendToSafe(ctx, body());
    expect(r).toMatchObject({ stage: "not_sent", receipt: null, error: "nope" });
    const [proposal] = await rows();
    expect(proposal.stage).toBe("not_sent");
    expect(proposal.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(await w.db.select().from(activity)).toHaveLength(0);
  });

  it("allows an identical retry after a definitive refusal at the same nonce", async () => {
    const propose = vi.spyOn(fake(), "proposeTransaction").mockRejectedValueOnce(new SafeServiceError(422, { nonFieldErrors: ["nope"] }));
    const first = await sendToSafe(ctx, body("d1"));
    const second = await sendToSafe(ctx, body("d2"));
    const all = await rows();
    expect(first.stage).toBe("not_sent");
    expect(second.stage).toBe("queued");
    expect(all.map((p) => p.nonce)).toEqual([0n, 0n]);
    expect(all[0].safeTxHash).toBe(all[1].safeTxHash);
    expect(all.find((p) => p.id === first.proposalId)?.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(propose).toHaveBeenCalledTimes(2);
  });

  it("refuses a plan that is not the live draft: Earlier plan, nothing stored", async () => {
    autoLive = false;
    await setLive("newer", "m2");
    const err = await sendToSafe(ctx, body("older")).catch((e) => e);
    expect(err).toBeInstanceOf(SendBlocked);
    expect(err.message).toBe("Earlier plan for $2,000. Use the newest plan.");
    expect(await rows()).toHaveLength(0);
    expect((await sendToSafe(ctx, body("newer"))).stage).toBe("queued");
  });

  it("an unknown outcome leaves the record sending", async () => {
    vi.spyOn(fake(), "proposeTransaction").mockRejectedValue(new TypeError("fetch failed"));
    const r = await sendToSafe(ctx, body());
    expect(r.stage).toBe("sending");
    expect(r.receipt).toBeNull();
  });

  it("the agent removed: 409 and nothing stored", async () => {
    vi.spyOn(fake(), "listDelegates").mockResolvedValue([]);
    await expect(sendToSafe(ctx, body())).rejects.toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(0);
  });

  it("a blocked test run is 422 and nothing is stored", async () => {
    vi.spyOn(w.services.testRunDeps, "simulate").mockResolvedValue({ ok: false, failedStep: 0, healthAfter: null, totalCollateralBase: 0n, totalDebtBase: 0n, gasUsed: 0n, feeUsd: 0 });
    const err = await sendToSafe(ctx, body()).catch((e) => e);
    expect(err).toBeInstanceOf(SendBlocked);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.line).toMatch(/Nothing was sent|failed/);
    expect(await rows()).toHaveLength(0);
  });

  it("does not trust cash it cannot back: too small a loan is 422", async () => {
    await expect(sendToSafe(ctx, body("x", { cash: 5 }))).rejects.toMatchObject({ status: 422 });
    expect(await rows()).toHaveLength(0);
  });

  it("after a failed execution the same plan can be sent again, one nonce higher", async () => {
    const a = await sendToSafe(ctx, body("d1"));
    const [first] = await rows();
    fake().confirm(first.safeTxHash as Hex, MOCK_OWNER);
    await mockExecute(w.services, 8453, first.safeTxHash as Hex, { revert: true });
    await refreshProposal(w.db, w.services, a.proposalId);
    expect((await rows())[0].stage).toBe("failed");
    const b = await sendToSafe(ctx, body("d2"));
    expect(b.stage).toBe("queued");
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === b.proposalId)!.nonce).toBe(first.nonce! + 1n);
  });

  it("an identical plan already in the queue under another draft key is a plain 409 and sends nothing", async () => {
    await sendToSafe(ctx, body("d1"));
    const [first] = await rows();
    // Force the collision: same plan, same nonce, but the live row has another idempotency key (a second tab), so only the hash index refuses it.
    await w.db.update(proposals).set({ idempotencyKey: "other-tab" }).where(eq(proposals.id, first.id));
    const spyProposal = vi.spyOn(fake(), "proposeTransaction");
    const spySign = vi.spyOn(w.services.signer, "signProposal");
    const err = await (async () => { await setLive("d2"); return send(ctx, body("d2"), { nonce: first.nonce! }); })().catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("This exact plan is already in your Safe queue. Open it from Activity, or change the amount and send again.");
    expect(spyProposal).not.toHaveBeenCalled();
    expect(spySign).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
  });
});

describe("recovery", () => {
  /** Accept at the service, then lose the response. */
  async function crashAfterAccept() {
    const real = fake().proposeTransaction.bind(fake());
    vi.spyOn(fake(), "proposeTransaction").mockImplementationOnce(async (p) => {
      await real(p);
      throw new TypeError("fetch failed");
    });
    const r = await sendToSafe(ctx, body());
    expect(r.stage).toBe("queued");
    vi.restoreAllMocks();
    return r.proposalId;
  }

  it("the service has it: marked queued without proposing again; Activity once", async () => {
    const id = await crashAfterAccept();
    const spy = vi.spyOn(fake(), "proposeTransaction");
    expect((await reconcileSending(ctx, id)).stage).toBe("queued");
    expect((await reconcileSending(ctx, id)).stage).toBe("queued");
    expect(spy).not.toHaveBeenCalled();
    expect(await w.db.select().from(activity)).toHaveLength(1);
  });

  it("the service does not have the hash yet: reconciliation polls without reposting or releasing the nonce", async () => {
    vi.spyOn(fake(), "proposeTransaction").mockRejectedValueOnce(new TypeError("timeout"));
    const r = await sendToSafe(ctx, body());
    const [before] = await rows();
    vi.restoreAllMocks();
    const spy = vi.spyOn(fake(), "proposeTransaction");
    expect(await reconcileAllSending(w.db, w.services)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    const [after] = await rows();
    expect(after.stage).toBe("sending");
    expect(after.submissionAttemptedAt).toEqual(before.submissionAttemptedAt);
    expect(after.safeTxHash).toBe(before.safeTxHash);
    expect(await fake().getMultisigTransaction(after.safeTxHash as Hex)).toBeNull();
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
    expect(r.proposalId).toBe(after.id);
  });

  it("pressing again on a sending record reconciles first", async () => {
    await crashAfterAccept();
    const spy = vi.spyOn(fake(), "proposeTransaction");
    expect((await sendToSafe(ctx, body())).stage).toBe("queued");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("nonce", () => {
  it("ignores an executed, not yet polled proposal: no gap", async () => {
    const { mockExecute } = await import("@/server/mock/safe-wallet");
    await sendToSafe(ctx, body("a"));
    const [first] = await rows();
    await mockExecute(w.services, 8453, first.safeTxHash as Hex); // chain nonce 1, local row still queued
    await sendToSafe(ctx, body("b", { cash: 1500 }));
    expect((await rows()).map((r) => r.nonce).sort()).toEqual([0n, 1n]);
  });

  it("fills a refused move's nonce before an already queued higher nonce", async () => {
    await sendToSafe(ctx, body("n0"));
    await sendToSafe(ctx, body("n1", { cash: 1500 }));
    await sendToSafe(ctx, body("n2", { cash: 1750 }));
    const existing = await rows();
    expect(existing.map((r) => r.nonce)).toEqual([0n, 1n, 2n]);

    const moveAtOne = existing.find((r) => r.nonce === 1n)!;
    await w.db.update(proposals).set({ stage: "not_sent", spec: { kind: "move" }, stopReason: "The quote expired." })
      .where(eq(proposals.id, moveAtOne.id));
    w.services.fixture.setNonce(8453, SAFE, 1n);

    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
    const replacement = await sendToSafe(ctx, body("fill-gap", { cash: 1200 }));
    const filled = (await rows()).find((r) => r.id === replacement.proposalId)!;
    expect(filled.nonce).toBe(1n);
    expect((await rows()).find((r) => r.nonce === 2n)?.stage).toBe("queued");
  });
});

describe("one quote path", () => {
  it("refuses mixed collateral like the quote does, and marks the draft out of date", async () => {
    const { saveQuoteDraft, getDraft } = await import("@/server/plan-drafts");
    const d = await saveQuoteDraft(w.db, safeId, { text: "$2,000", hfIdx: 1, months: 12, cash: 2000, messageId: "m1" });
    w.services.fixture.setPosition(8453, MOCK_SAFE, {
      chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
      collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
      healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: true, blockNumber: 1n,
    });
    await expect(sendToSafe(ctx, body(d.draftKey!))).rejects.toBeInstanceOf(SendBlocked);
    expect(await rows()).toHaveLength(0);
    expect((await getDraft(w.db, safeId))?.outOfDate).toBe(true);
  });
});

describe("asset", () => {
  it("with no asset in the request, the proposal uses the quote's asset (the existing loan's collateral)", async () => {
    w.services.fixture.setBalances(8453, MOCK_SAFE, { ETH: 2.5, wstETH: 5 });
    w.services.fixture.setPosition(8453, MOCK_SAFE, {
      chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
      collateral: [{ asset: "wstETH", token: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", amount: 1, usd: 3500 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
      healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n,
    });
    const r = await sendToSafe(ctx, body("w1", { cash: 1500 }));
    expect(r.stage).toBe("queued");
    const [row] = await rows();
    expect(row.spec).toMatchObject({ asset: "wstETH" });
  });
});

describe("sentReceiptOf", () => {
  it("gives the receipt for an open proposal at any stage after queued", async () => {
    await sendToSafe(ctx, body());
    const [row] = await rows();
    await w.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, row.id));
    const [executed] = await rows();
    expect(sentReceiptOf(executed)).toMatch(/^Sent to your Safe: borrow \$2,000 from Aave v3, locking /);
    expect(sentReceiptOf({ ...executed, spec: { kind: "close" }, title: "Close the loan" })).toBe("Sent to your Safe: Close the loan.");
    expect(sentReceiptOf({ ...executed, spec: { kind: "repay" }, title: "Repay 200 USDC on Morpho" })).toBe("Sent to your Safe: Repay 200 USDC on Morpho.");
    expect(sentReceiptOf({ ...executed, spec: { kind: "unknown-kind" } })).toBeNull();
  });
});
