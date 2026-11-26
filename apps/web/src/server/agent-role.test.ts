import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { proposals } from "@/server/db/schema";
import { mockExecute } from "@/server/mock/safe-wallet";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import type { Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../tests/helpers/world";
import { removeAgent } from "./agent-role";
import { followOpenProposals } from "./proposals/follow";
import { sendLive as sendToSafe } from "@/../tests/helpers/live-send";
import { draftState, saveQuoteDraft } from "./plan-drafts";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
const fake = () => w.services.fakes.get(8453)!;
const rows = () => w.db.select().from(proposals);
const removal = async () => ({ signatures: [{ chainId: 8453, signature: await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address)) }] });

beforeEach(async () => {
  w = await createTestWorld();
  await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => { vi.restoreAllMocks(); w.reset(); });

/** The service accepts the proposal, the response is lost: the postflight poll sees it. */
async function crashAfterAccept() {
  const real = fake().proposeTransaction.bind(fake());
  vi.spyOn(fake(), "proposeTransaction").mockImplementationOnce(async (p) => {
    await real(p);
    throw new TypeError("fetch failed");
  });
  const r = await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1 });
  expect(r.stage).toBe("queued");
  vi.restoreAllMocks();
}

describe("removeAgent and a sending proposal", () => {
  it("stops a sending proposal the service already has, and deletes it from the queue", async () => {
    await crashAfterAccept();
    const [before] = await rows();
    await removeAgent(ctx, await removal());
    const [row] = await rows();
    expect(row).toMatchObject({ stage: "stopped", stopReason: "agent_removed", deletedFromQueue: true });
    expect(await fake().getMultisigTransaction(before.safeTxHash as Hex)).toBeNull();
    await followOpenProposals(w.db, w.services);
    expect((await rows())[0].stage).toBe("stopped");
  });

  it("stops a sending proposal before any submission attempt", async () => {
    vi.spyOn(w.services.signer, "signProposal").mockRejectedValueOnce(new TypeError("signer unavailable"));
    expect((await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1 })).stage).toBe("sending");
    vi.restoreAllMocks();
    await removeAgent(ctx, await removal());
    expect((await rows())[0]).toMatchObject({ stage: "stopped", stopReason: "agent_removed", deletedFromQueue: true });
    await followOpenProposals(w.db, w.services);
    expect((await rows())[0].stage).toBe("stopped");
  });

  it("does not submit a proposal without an intent after the Safe no longer has the agent", async () => {
    vi.spyOn(w.services.signer, "signProposal").mockRejectedValueOnce(new TypeError("signer unavailable"));
    expect((await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1 })).stage).toBe("sending");
    await fake().removeDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, signature: (await removal()).signatures[0].signature as Hex });
    await followOpenProposals(w.db, w.services);
    expect((await rows())[0].stage).not.toBe("queued");
    expect((await rows())[0].stage).toBe("stopped");
  });

  it("does not overwrite an already-executed transaction as stopped", async () => {
    const r = await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1 });
    const [row] = await rows();
    await mockExecute(w.services, 8453, row.safeTxHash as Hex);
    await removeAgent(ctx, await removal());
    expect((await rows())[0].stage).not.toBe("stopped");
    await followOpenProposals(w.db, w.services);
    expect((await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId)))[0].stage).toBe("executed");
  });
});

describe("a stopped proposal and the plan card", () => {
  const draft = () => saveQuoteDraft(w.db, 1, { text: "$2,000", hfIdx: 1, months: 12, cash: 2000, messageId: "m1" });
  const safeIdOf = async () => (await rows())[0].safeId;

  it("stopped because the service never had it: the card is not sent", async () => {
    const d = await draft();
    vi.spyOn(fake(), "proposeTransaction").mockRejectedValueOnce(new TypeError("timeout"));
    vi.spyOn(w.services.signer, "signProposal").mockRejectedValueOnce(new TypeError("signer unavailable"));
    expect((await sendToSafe(ctx, { draftKey: d.draftKey!, chainId: 8453, cash: 2000, hfIdx: 1 })).stage).toBe("sending");
    vi.restoreAllMocks();
    await removeAgent(ctx, await removal());
    expect((await rows())[0].stage).toBe("stopped");
    expect((await draftState(w.db, await safeIdOf(), "m1")).sentId).toBeUndefined();
  });

  it("stopped after the service accepted it: the card is sent", async () => {
    const d = await draft();
    const real = fake().proposeTransaction.bind(fake());
    vi.spyOn(fake(), "proposeTransaction").mockImplementationOnce(async (p) => { await real(p); throw new TypeError("fetch failed"); });
    expect((await sendToSafe(ctx, { draftKey: d.draftKey!, chainId: 8453, cash: 2000, hfIdx: 1 })).stage).toBe("queued");
    vi.restoreAllMocks();
    await removeAgent(ctx, await removal());
    expect((await rows())[0].stage).toBe("stopped");
    expect((await draftState(w.db, await safeIdOf(), "m1")).sentId).toBe((await rows())[0].id);
  });
});

describe("removal when a queued transaction is not confirmed absent", () => {
  it("keeps the proposal nonce held and asks the owner to check Safe", async () => {
    const r = await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1 });
    expect(r.stage).toBe("queued");
    vi.spyOn(fake(), "getMultisigTransaction").mockResolvedValue(null);
    await removeAgent(ctx, await removal());
    const [row] = await rows();
    expect(row).toMatchObject({ stage: "stopped", deletedFromQueue: false });
    const { proposalView } = await import("./proposals/view");
    const v = proposalView(row, { viewer: MOCK_OWNER, threshold: 2, safeAddress: SAFE });
    expect(v.final).toBe(false);
    expect(v.sentence).toMatch(/still in your Safe queue/);
  });
});
