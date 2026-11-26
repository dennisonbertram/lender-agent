import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordActivity } from "@/server/activity";
import { recordSignatures } from "@/server/activity-view";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { GET } from "@/app/api/safes/[address]/activity/route";
import { createTestWorld, type TestWorld } from "../helpers/world";

describe("GET /api/safes/[address]/activity", () => {
  let world: TestWorld;
  let safeId: number;
  beforeEach(async () => { world = await createTestWorld(); safeId = await world.trackSafe(MOCK_SAFE); });
  afterEach(() => world.reset());

  const get = async (wallet: typeof MOCK_OWNER) => {
    const { cookie } = await world.signIn(wallet);
    return GET(world.req(`/api/safes/${MOCK_SAFE}/activity`, { cookie }), { params: Promise.resolve({ address: MOCK_SAFE }) });
  };

  it("returns a full loan in order, with the actor computed for each viewer", async () => {
    const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 12, m));
    const base = { safeId, chainId: 8453 as const, proposalId: "p1" };
    await recordActivity(world.db, { safeId, chainId: 8453, actor: "Agent", kind: "read", text: "Checked loan", at: t(0) });
    await recordActivity(world.db, { ...base, actor: "Agent", kind: "proposed", text: "Proposed repay", at: t(1) });
    await recordActivity(world.db, { ...base, actor: "Agent", kind: "status", text: "In your Safe queue", at: t(2) });
    await recordSignatures(world.db, { ...base, safeTxHash: "0xaa", title: "Repay", confirmations: [{ owner: MOCK_COSIGNER, submittedAt: t(3) }] });
    await recordSignatures(world.db, { ...base, safeTxHash: "0xaa", title: "Repay", confirmations: [{ owner: MOCK_COSIGNER, submittedAt: t(3) }, { owner: MOCK_OWNER, submittedAt: t(4) }] });
    await recordActivity(world.db, { ...base, actor: "Agent", kind: "status", text: "Executed", at: t(5) });

    const ownerRes = await get(MOCK_OWNER);
    expect(ownerRes.status).toBe(200);
    const owner = (await ownerRes.json()).activity;
    expect(owner.map((r: { text: string }) => r.text)).toEqual(["Executed", "Signed: Repay", "Signed: Repay", "In your Safe queue", "Proposed repay", "Checked loan"]);
    expect(owner.map((r: { actor: string }) => r.actor)).toEqual(["Agent", "You", expect.stringMatching(/^Co-signer 0x3C44/i), "Agent", "Agent", "Agent"]);

    const co = (await (await get(MOCK_COSIGNER)).json()).activity;
    expect(co.map((r: { actor: string }) => r.actor).slice(1, 3)).toEqual([expect.stringMatching(/^Co-signer 0x7099/i), "You"]);
  });

  it("is 403 for a stranger and 401 signed out", async () => {
    expect((await get(MOCK_STRANGER)).status).toBe(403);
    const res = await GET(world.req(`/api/safes/${MOCK_SAFE}/activity`), { params: Promise.resolve({ address: MOCK_SAFE }) });
    expect(res.status).toBe(401);
  });
});
