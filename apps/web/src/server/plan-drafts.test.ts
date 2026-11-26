import { afterEach, describe, expect, it } from "vitest";
import { createTestWorld } from "../../tests/helpers/world";
import { MOCK_SAFE } from "@/server/mock/seed";
import { proposals } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { draftState, getDraft, markDraftSent, saveQuoteDraft } from "./plan-drafts";

const fields = { text: "$5,000", hfIdx: 1 as const, months: 12 as const, cash: 5000 };

describe("plan drafts", () => {
  let world: Awaited<ReturnType<typeof createTestWorld>>;
  afterEach(() => world?.reset());
  const setup = async () => { world = await createTestWorld(); return world.trackSafe(MOCK_SAFE); };

  it("keeps one live draft per Safe; the older card is not live", async () => {
    const id = await setup();
    const a = await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" });
    expect(a.live).toBe(true);
    const b = await saveQuoteDraft(world.db, id, { ...fields, cash: 7000, text: "$7,000", messageId: "m2" });
    expect(b.live).toBe(true);
    expect(b.draftKey).not.toBe(a.draftKey);
    expect((await draftState(world.db, id, "m1")).live).toBe(false);
    expect((await draftState(world.db, id, "m2")).live).toBe(true);
    // Reopening the old card does not take the live place back.
    expect((await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" })).live).toBe(false);
    expect((await getDraft(world.db, id))?.msgId).toBe("m2");
  });

  it("the key is stable across edits and after send", async () => {
    const id = await setup();
    const a = await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" });
    const edited = await saveQuoteDraft(world.db, id, { ...fields, cash: 6000, text: "$6,000", messageId: "m1" });
    expect(edited.draftKey).toBe(a.draftKey);
    await world.db.insert(proposals).values({ id: "p1", safeId: id, chainId: 8453, spec: {}, idempotencyKey: "k-p1", title: "t", steps: [], outcome: "o", stage: "queued" });
    expect(await markDraftSent(world.db, id, a.draftKey!, "p1")).toBe(true);
    const after = await saveQuoteDraft(world.db, id, { ...fields, cash: 9000, text: "$9,000", messageId: "m1" });
    expect(after).toEqual({ live: true, draftKey: a.draftKey, sentId: "p1" });
    expect((await getDraft(world.db, id))?.cash).toBe(6000);
    expect(await markDraftSent(world.db, id, "other", "p2")).toBe(false);
  });

  it("a draft whose key already has a proposal reads as sent", async () => {
    const id = await setup();
    const a = await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" });
    await world.db.insert(proposals).values({ id: "prop-1", safeId: id, chainId: 8453, spec: {}, idempotencyKey: a.draftKey!, title: "t", steps: [], outcome: "o", stage: "queued" });
    expect((await draftState(world.db, id, "m1")).sentId).toBe("prop-1");
  });
});

describe("plan drafts and proposal stages", () => {
  let world: Awaited<ReturnType<typeof createTestWorld>>;
  afterEach(() => world?.reset());
  const put = async (stage: string) => {
    world = await createTestWorld();
    const id = await world.trackSafe(MOCK_SAFE);
    const a = await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" });
    await world.db.insert(proposals).values({ id: "prop-1", safeId: id, chainId: 8453, spec: {}, idempotencyKey: a.draftKey!, title: "t", steps: [], outcome: "o", stage: stage as never, stopReason: "nope" });
    return { id, a };
  };

  it("not_sent is not sent: the form stays and carries the error", async () => {
    const { id, a } = await put("not_sent");
    const s = await draftState(world.db, id, "m1");
    expect(s.sentId).toBeUndefined();
    expect(s).toMatchObject({ live: true, notSent: { id: "prop-1", error: "nope" } });
    expect(await markDraftSent(world.db, id, a.draftKey!, "prop-1")).toBe(true);
    expect((await draftState(world.db, id, "m1")).sentId).toBeUndefined();
  });

  it("sending is pending, not sent", async () => {
    const { id } = await put("sending");
    const s = await draftState(world.db, id, "m1");
    expect(s.sentId).toBeUndefined();
    expect(s.sendingId).toBe("prop-1");
  });

  it.each(["queued", "executed"])("%s is sent", async (stage) => {
    const { id } = await put(stage);
    expect((await draftState(world.db, id, "m1")).sentId).toBe("prop-1");
  });
});

describe("plan drafts: the receipt", () => {
  let world: Awaited<ReturnType<typeof createTestWorld>>;
  afterEach(() => world?.reset());

  it("comes from the stored spec, before and after the proposal executes", async () => {
    world = await createTestWorld();
    const id = await world.trackSafe(MOCK_SAFE);
    const a = await saveQuoteDraft(world.db, id, { ...fields, cash: 3500, text: "$3,500", messageId: "m1" });
    const spec = { kind: "open", venueId: "aave-v3", asset: "ETH", amount: 0.97, borrow: 1500, safeId: MOCK_SAFE.toLowerCase(), network: "base" };
    await world.db.insert(proposals).values({ id: "p1", safeId: id, chainId: 8453, spec, idempotencyKey: "k-p1", title: "Open a $1,500 Aave v3 loan", steps: [], outcome: "o", stage: "queued" });
    expect(await markDraftSent(world.db, id, a.draftKey!, "p1")).toBe(true);
    const receipt = "Sent to your Safe: borrow $1,500 from Aave v3, locking 0.97 ETH.";
    expect((await draftState(world.db, id, "m1")).receipt).toBe(receipt);
    await world.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, "p1"));
    expect((await draftState(world.db, id, "m1")).receipt).toBe(receipt);
  });

  it("is found through the idempotency key too", async () => {
    world = await createTestWorld();
    const id = await world.trackSafe(MOCK_SAFE);
    const a = await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" });
    const spec = { kind: "open", venueId: "aave-v3", asset: "ETH", amount: 0.97, borrow: 1500, safeId: MOCK_SAFE.toLowerCase(), network: "base" };
    await world.db.insert(proposals).values({ id: "p2", safeId: id, chainId: 8453, spec, idempotencyKey: a.draftKey!, title: "t", steps: [], outcome: "o", stage: "executed" });
    const s = await draftState(world.db, id, "m1");
    expect(s.sentId).toBe("p2");
    expect(s.receipt).toBe("Sent to your Safe: borrow $1,500 from Aave v3, locking 0.97 ETH.");
  });

  it("does not reveal a saved receipt after ownership of its network is lost", async () => {
    world = await createTestWorld();
    const id = await world.trackSafe(MOCK_SAFE);
    const a = await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" });
    const spec = { kind: "open", venueId: "aave-v3", asset: "ETH", amount: 0.97, borrow: 1500, safeId: MOCK_SAFE.toLowerCase(), network: "arbitrum" };
    await world.db.insert(proposals).values({ id: "p-arb", safeId: id, chainId: 42161, spec, idempotencyKey: a.draftKey!, title: "Open an Arbitrum loan", steps: [], outcome: "o", stage: "queued" });
    await markDraftSent(world.db, id, a.draftKey!, "p-arb");

    const state = await draftState(world.db, id, "m1", [8453]);
    expect(state).toMatchObject({ live: true, draftKey: a.draftKey });
    expect(state.sentId).toBeUndefined();
    expect(state.receipt).toBeUndefined();
  });

  it("does not report a pending send on a network the borrower no longer owns", async () => {
    world = await createTestWorld();
    const id = await world.trackSafe(MOCK_SAFE);
    const a = await saveQuoteDraft(world.db, id, { ...fields, messageId: "m1" });
    await world.db.insert(proposals).values({ id: "p-arb-pending", safeId: id, chainId: 42161, spec: { kind: "open" }, idempotencyKey: "pending", title: "Open an Arbitrum loan", steps: [], outcome: "o", stage: "sending" });

    const state = await draftState(world.db, id, "m1", [8453]);
    expect(state).toMatchObject({ live: true, draftKey: a.draftKey });
    expect(state.pendingSend).toBeUndefined();
  });
});
