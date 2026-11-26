import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposals } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { safeTxHash } from "@/server/safe/hash";
import type { SafeTx } from "@/shared/types";
import { GET as getOne } from "@/app/api/safes/[address]/proposals/[id]/route";
import { GET as getList } from "@/app/api/safes/[address]/proposals/list/route";
import { createTestWorld, type TestWorld } from "../helpers/world";

const tx: SafeTx = { to: "0x1111111111111111111111111111111111111111", value: "0", data: "0xdeadbeef", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: "3" };

describe("proposal access (BP-28)", () => {
  let world: TestWorld;
  const hash = safeTxHash(8453, MOCK_SAFE, tx);
  beforeEach(async () => {
    world = await createTestWorld();
    const safeId = await world.trackSafe(MOCK_SAFE, { chainIds: [8453, 42161] });
    world.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_STRANGER], 1);
    const base = { safeId, spec: {}, tx, nonce: 3n, title: "Protect Aave loan", steps: ["Allow Aave", "Supply"], outcome: "Uses 1 ETH.", stage: "queued", threshold: 2 };
    await world.db.insert(proposals).values({ ...base, id: "p-base", chainId: 8453, safeTxHash: hash, idempotencyKey: "k1", confirmations: [{ owner: MOCK_OWNER, submittedAt: "2026-01-01T00:00:00Z" }] });
    await world.db.insert(proposals).values({ ...base, id: "p-sep", chainId: 42161, safeTxHash: safeTxHash(42161, MOCK_SAFE, tx), idempotencyKey: "k2" });
  });
  afterEach(() => world.reset());

  const one = async (wallet: typeof MOCK_OWNER, id = "p-base") => {
    const { cookie } = await world.signIn(wallet);
    return getOne(world.req(`/api/safes/${MOCK_SAFE}/proposals/${id}`, { cookie }), { params: Promise.resolve({ address: MOCK_SAFE, id }) });
  };
  const list = async (wallet: typeof MOCK_OWNER) => {
    const { cookie } = await world.signIn(wallet);
    return getList(world.req(`/api/safes/${MOCK_SAFE}/proposals/list?open=1`, { cookie }), { params: Promise.resolve({ address: MOCK_SAFE }) });
  };

  it("shows the owner and the co-signer the same summary", async () => {
    const a = (await (await one(MOCK_OWNER)).json()).proposal;
    const b = (await (await one(MOCK_COSIGNER)).json()).proposal;
    for (const p of [a, b]) {
      expect(p).toMatchObject({ title: "Protect Aave loan", steps: ["Allow Aave", "Supply"], outcome: "Uses 1 ETH.", safeTxHash: hash, hashMismatch: false, sentence: "1 of 2 signed. Needs 1 more signature." });
    }
    // The facts are the same for both; only the viewer's own part differs: whether they signed, and their next step (r4).
    const own = (p: any) => ({ ...p, viewerSigned: 0, nextStep: 0, state: 0, canSign: 0, canSend: 0, owners: p.owners.map((o: any) => o.address), approvals: p.approvals?.map((x: any) => ({ ...x, isYou: 0 })) });
    expect(own(a)).toEqual(own(b));
    expect([a.canSign, b.canSign]).toEqual([false, true]); // the fixture nonce is ahead of the chain: state "blocked", still signable
    expect([a.viewerSigned, b.viewerSigned]).toEqual([true, false]);
    expect(a.nextStep).toBe("You signed. Waiting for the other owner.");
    expect(b.nextStep).toMatch(/^Your signature is needed\./);
  });

  it("gives a stranger no data", async () => {
    const res = await one(MOCK_STRANGER);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("Protect Aave");
  });

  it("hides a proposal on a network the viewer does not own, and 404s an unknown id", async () => {
    expect((await one(MOCK_OWNER, "p-sep")).status).toBe(403);
    expect((await one(MOCK_STRANGER, "p-sep")).status).toBe(200);
    expect((await one(MOCK_STRANGER, "p-base")).status).toBe(403);
    expect((await one(MOCK_OWNER, "nope")).status).toBe(404);
  });

  it("resolves a 0x safeTxHash like the app id, with the same access checks", async () => {
    const res = await one(MOCK_OWNER, hash);
    expect(res.status).toBe(200);
    expect((await res.json()).proposal.id).toBe("p-base");
    expect((await one(MOCK_OWNER, hash.toUpperCase().replace("0X", "0x"))).status).toBe(200);
    expect((await one(MOCK_STRANGER, hash)).status).toBe(403);
    expect((await one(MOCK_OWNER, safeTxHash(42161, MOCK_SAFE, tx))).status).toBe(403);
    expect((await one(MOCK_OWNER, "0x" + "ab".repeat(32))).status).toBe(404);
  });

  it("lists open proposals only on owned networks", async () => {
    expect((await (await list(MOCK_OWNER)).json()).proposals.map((p: { id: string }) => p.id)).toEqual(["p-base"]);
    expect((await (await list(MOCK_STRANGER)).json()).proposals.map((p: { id: string }) => p.id)).toEqual(["p-sep"]);
  });
});
