import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GET as listSafes, POST as postSafe } from "@/app/api/safes/route";
import { GET as ownedSafes } from "@/app/api/safes/owned/route";
import { GET as summary } from "@/app/api/safes/[address]/route";
import { activity, safes, userSafes } from "@/server/db/schema";
import { privateKeyToAccount } from "viem/accounts";
import { delegateTypedData } from "@/server/safe/hash";
import { MOCK_OWNER_KEY, MOCK_COSIGNER, MOCK_EMPTY_SAFE, MOCK_OWNER, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { createTestWorld, type TestWorld } from "../helpers/world";

let world: TestWorld;
beforeEach(async () => { world = await createTestWorld(); });
afterEach(() => world.reset());

const params = (address: string) => ({ params: Promise.resolve({ address }) });
const add = (cookie: string, address: string, name?: string) => postSafe(world.req("/api/safes", { method: "POST", cookie, json: { address, name } }));

describe("safes", () => {
  it("lists the Safes an owner has through the Transaction Service", async () => {
    const { cookie } = await world.signIn(MOCK_OWNER);
    const body = await (await ownedSafes(world.req("/api/safes/owned", { cookie }))).json();
    expect(body.safes).toHaveLength(2);
    const s = body.safes.find((x: { address: string }) => x.address === MOCK_SAFE);
    expect(s).toMatchObject({ threshold: 2, ownerCount: 2, chainIds: [8453] });
    expect((await ownedSafes(world.req("/api/safes/owned"))).status).toBe(401);
    const none = await world.signIn(MOCK_STRANGER);
    expect((await (await ownedSafes(world.req("/api/safes/owned", { cookie: none.cookie }))).json()).safes).toEqual([]);
  });

  it("answers one served network at a time for progressive pickers, and rejects unserved ones", async () => {
    const { cookie } = await world.signIn(MOCK_OWNER);
    const base = await (await ownedSafes(world.req("/api/safes/owned?chainId=8453", { cookie }))).json();
    expect(base.safes).toHaveLength(2);
    expect(base.safes.map((s: { chainIds: number[] }) => s.chainIds)).toEqual([[8453], [8453]]);
    for (const s of base.safes) {
      expect(s.networkDetails).toHaveLength(1);
      expect(s.networkDetails[0].chainId).toBe(8453);
    }
    const arb = await (await ownedSafes(world.req("/api/safes/owned?chainId=42161", { cookie }))).json();
    expect(arb.safes).toEqual([]);
    expect((await ownedSafes(world.req("/api/safes/owned?chainId=10", { cookie }))).status).toBe(400);
    expect((await ownedSafes(world.req("/api/safes/owned?chainId=soon", { cookie }))).status).toBe(400);
    expect((await ownedSafes(world.req("/api/safes/owned?chainId=8453"))).status).toBe(401);
  });

  it("adds a Safe by address: saved with its threshold and an Activity row", async () => {
    const { cookie, userId } = await world.signIn(MOCK_OWNER);
    const res = await add(cookie, MOCK_SAFE, "Treasury");
    expect(res.status).toBe(201);
    const [row] = await world.db.select().from(safes).where(eq(safes.address, MOCK_SAFE.toLowerCase()));
    expect(row.name).toBe("Treasury");
    expect(await world.db.select().from(userSafes).where(eq(userSafes.userId, userId))).toHaveLength(1);
    expect(await world.db.select().from(activity).where(eq(activity.safeId, row.id))).toHaveLength(1);
    const list = await (await listSafes(world.req("/api/safes", { cookie }))).json();
    expect(list.safes.map((s: { address: string }) => s.address)).toEqual([MOCK_SAFE.toLowerCase()]);
    const sum = await (await summary(world.req(`/api/safes/${MOCK_SAFE}`, { cookie }), params(MOCK_SAFE))).json();
    expect(sum.safe.threshold).toBe("2 of 2");
  });

  it("rejects a stranger, bad input and duplicates, and saves nothing", async () => {
    const stranger = await world.signIn(MOCK_STRANGER);
    const r = await add(stranger.cookie, MOCK_SAFE);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not an owner/);
    expect(await world.db.select().from(safes)).toHaveLength(0);
    const { cookie } = await world.signIn(MOCK_OWNER);
    expect((await (await add(cookie, "")).json()).error).toBe("Enter an address.");
    expect((await (await add(cookie, "0x12")).json()).error).toMatch(/^This is not a valid address/);
    expect((await add(cookie, MOCK_SAFE)).status).toBe(201);
    const dup = await add(cookie, MOCK_SAFE.toLowerCase());
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toBe("You already added this Safe.");
    expect(await world.db.select().from(safes)).toHaveLength(1);
  });

  it("records whether the agent is already a delegate", async () => {
    world.services.fakes.get(8453)!.setOwners(MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
    const signature = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, world.services.signer.address));
    await world.services.fakes.get(8453)!.addDelegate({ safe: MOCK_SAFE, delegate: world.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature });
    const { cookie } = await world.signIn(MOCK_OWNER);
    const res = await (await add(cookie, MOCK_SAFE)).json();
    expect(res.agent).toBe(true);
  });

  it("summary reads balances live from the chain with a block number, and 403s non-owners", async () => {
    const { cookie, userId } = await world.signIn(MOCK_OWNER);
    await world.trackSafe(MOCK_SAFE, { userId });
    const body = await (await summary(world.req(`/api/safes/${MOCK_SAFE}`, { cookie }), params(MOCK_SAFE))).json();
    expect(body.safe.balances.base.ETH).toBe(2.5);
    expect(body.balancesBlock).toBeGreaterThan(0);
    expect(body).toMatchObject({ ownedChainIds: [8453], chat: true, ownersDiffer: false, ownerCount: 2, loans: [] });
    world.services.fixture.setBalances(8453, MOCK_SAFE, { ETH: 4, wstETH: 0, USDC: 0 });
    const again = await (await summary(world.req(`/api/safes/${MOCK_SAFE}`, { cookie }), params(MOCK_SAFE))).json();
    expect(again.safe.balances.base.ETH).toBe(4);
    const s = await world.signIn(MOCK_STRANGER);
    expect((await summary(world.req(`/api/safes/${MOCK_SAFE}`, { cookie: s.cookie }), params(MOCK_SAFE))).status).toBe(403);
  });

  it("a co-signer removed on-chain no longer sees the Safe", async () => {
    const { cookie, userId } = await world.signIn(MOCK_COSIGNER);
    await world.trackSafe(MOCK_SAFE, { userId });
    const ids = async () => (await (await listSafes(world.req("/api/safes", { cookie }))).json()).safes.length;
    expect(await ids()).toBe(1);
    world.services.fixture.setOwners(8453, MOCK_SAFE, [MOCK_OWNER], 1);
    // The access cache holds for a few seconds; a fresh services object starts empty.
    const fresh = { ...world.services, access: (await import("@/server/auth/access")).createAccess({ readOwners: world.services.fixture.readSafeOwners }) };
    (await import("@/server/services")).setServicesForTests(fresh);
    expect(await ids()).toBe(0);
    void MOCK_EMPTY_SAFE;
  });
});
