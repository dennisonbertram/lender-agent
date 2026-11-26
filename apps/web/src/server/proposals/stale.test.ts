import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { proposals } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import type { Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { getProposal } from "./read";
import { sendLive as sendToSafe } from "@/../tests/helpers/live-send";
import { checkStale, markStaleAll } from "./stale";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
const fake = () => w.services.fakes.get(8453)!;
const stageOf = async (id: string) => (await w.db.select().from(proposals).where(eq(proposals.id, id)))[0].stage;

beforeEach(async () => {
  w = await createTestWorld();
  await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => w.reset());

const queue = async () => (await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1 })).proposalId;

describe("checkStale", () => {
  it("unchanged: not stale", async () => {
    const id = await queue();
    expect(await checkStale(w.db, w.services, id)).toBe(false);
    expect(await stageOf(id)).toBe("queued");
  });

  it("balances changed so it no longer matches: stale, with the sentence and still-queued note", async () => {
    const id = await queue();
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0, wstETH: 0, USDC: 0 });
    expect(await checkStale(w.db, w.services, id)).toBe(true);
    expect(await stageOf(id)).toBe("stale");
    const v = await getProposal(ctx, id);
    expect(v.stage).toBe("stale");
    expect(v.sentence).toBe("Out of date: the loan changed. It is still in your Safe queue. Reject it in Safe too.");
  });

  it("a draft that is out of date says nothing was sent", async () => {
    const id = await queue();
    await w.db.update(proposals).set({ stage: "draft", safeTxHash: null }).where(eq(proposals.id, id));
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0, wstETH: 0, USDC: 0 });
    expect((await getProposal(ctx, id)).sentence).toBe("Out of date: the loan changed. Nothing was sent.");
  });

  it("the Safe nonce moved past the proposal's: stale", async () => {
    const id = await queue();
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    w.services.fixture.setNonce(8453, SAFE, row.nonce! + 1n);
    expect(await checkStale(w.db, w.services, id)).toBe(true);
  });

  it("the stale proposal view reports a passed Safe nonce separately from its lingering queue row", async () => {
    const id = await queue();
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    w.services.fixture.setNonce(8453, SAFE, row.nonce! + 1n);
    expect(await checkStale(w.db, w.services, id)).toBe(true);
    const view = await getProposal(ctx, id);
    expect(view).toMatchObject({ stage: "stale", inSafe: true, noncePassed: true });
  });

  it("one that already executed is left to the follower", async () => {
    const id = await queue();
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    fake().markExecuted(row.safeTxHash as Hex, { success: true, txHash: `0x${"22".repeat(32)}` });
    w.services.fixture.setNonce(8453, SAFE, row.nonce! + 1n);
    expect(await checkStale(w.db, w.services, id)).toBe(false);
  });

  it("markStaleAll rechecks every open proposal", async () => {
    const id = await queue();
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0, wstETH: 0, USDC: 0 });
    await markStaleAll(w.db, w.services);
    expect(await stageOf(id)).toBe("stale");
  });

  it.each(["compound-v3", "morpho-blue"])("a %s proposal with nothing changed stays queued (it is checked against its own lender)", async (venueId) => {
    const id = (await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1, venueId })).proposalId;
    expect(await checkStale(w.db, w.services, id)).toBe(false);
    expect(await stageOf(id)).toBe("queued");
    await markStaleAll(w.db, w.services);
    expect(await stageOf(id)).toBe("queued");
  });

  it("a lender that cannot be read is 'cannot check', not stale", async () => {
    const id = (await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1, venueId: "compound-v3" })).proposalId;
    (w.services.lenders as import("@/server/lenders/fixture").FixtureLenders).fail("compound-v3");
    expect(await checkStale(w.db, w.services, id)).toBe(false);
    expect(await stageOf(id)).toBe("queued");
  });
});
