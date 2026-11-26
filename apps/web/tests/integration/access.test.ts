import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/server/db/test-db";
import { setDbForTests } from "@/server/db/client";
import { safeNetworks, safes, userSafes } from "@/server/db/schema";
import { createAccess, listSafesForWallet, requireChat, requireNetwork } from "@/server/auth/access";
import { buildSignInMessage } from "@/server/auth/siwe";
import { HttpError } from "@/server/http";
import type { Address, ChainId } from "@/shared/types";
import { ANVIL_KEYS } from "../helpers/anvil";
import { GET as nonceGET } from "@/app/api/auth/nonce/route";
import { POST as verifyPOST } from "@/app/api/auth/verify/route";
import { GET as sessionGET } from "@/app/api/auth/session/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";

const owner = privateKeyToAccount(ANVIL_KEYS[1]);
const stranger = privateKeyToAccount(ANVIL_KEYS[2]);
const SAFE = "0x1111111111111111111111111111111111111111" as Address;

function fakeChain(initial: Record<string, Address[] | null>) {
  const state = { ...initial };
  const readOwners = vi.fn(async (c: ChainId, s: Address) => state[`${c}:${s.toLowerCase()}`] ?? null);
  return { state, readOwners };
}

describe("safeAccess", () => {
  it("allows an owner on every network, with chat", async () => {
    const { readOwners } = fakeChain({ [`8453:${SAFE}`]: [owner.address], [`42161:${SAFE}`]: [owner.address] });
    const a = await createAccess({ readOwners }).safeAccess(owner.address, SAFE, [8453, 42161]);
    expect(a).toEqual({ ownedChainIds: [8453, 42161], trackedChainIds: [8453, 42161], chat: true, ownersDiffer: false, unreadChainIds: [] });
    expect(() => requireNetwork(a, 8453)).not.toThrow();
    expect(() => requireChat(a)).not.toThrow();
  });

  it("denies a stranger with 403 for everything", async () => {
    const { readOwners } = fakeChain({ [`8453:${SAFE}`]: [owner.address] });
    const a = await createAccess({ readOwners }).safeAccess(stranger.address, SAFE, [8453]);
    expect(a.ownedChainIds).toEqual([]);
    for (const f of [() => requireNetwork(a, 8453), () => requireChat(a)]) {
      try { f(); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(HttpError); expect((e as HttpError).status).toBe(403); }
    }
  });

  it("owner on one network only: that network allowed, chat denied, owners differ", async () => {
    const other = privateKeyToAccount(ANVIL_KEYS[3]);
    const { readOwners } = fakeChain({ [`8453:${SAFE}`]: [owner.address], [`42161:${SAFE}`]: [other.address] });
    const a = await createAccess({ readOwners }).safeAccess(owner.address, SAFE, [8453, 42161]);
    expect(a).toMatchObject({ ownedChainIds: [8453], chat: false, ownersDiffer: true });
    expect(() => requireNetwork(a, 8453)).not.toThrow();
    expect(() => requireNetwork(a, 42161)).toThrow(HttpError);
    expect(() => requireChat(a)).toThrow(HttpError);
  });

  it("caches reads for cacheMs only", async () => {
    const { readOwners } = fakeChain({ [`8453:${SAFE}`]: [owner.address] });
    let t = 1000;
    const access = createAccess({ readOwners, cacheMs: 15000, now: () => t });
    await access.safeAccess(owner.address, SAFE, [8453]);
    await access.safeAccess(owner.address, SAFE, [8453]);
    expect(readOwners).toHaveBeenCalledTimes(1);
    t += 15001;
    await access.safeAccess(owner.address, SAFE, [8453]);
    expect(readOwners).toHaveBeenCalledTimes(2);
  });

  it("keeps verified ownership while reporting a failed network read as unknown", async () => {
    const readOwners = vi.fn(async (chainId: ChainId) => {
      if (chainId === 42161) throw new Error("temporary RPC failure");
      return [owner.address];
    });
    const a = await createAccess({ readOwners }).safeAccess(owner.address, SAFE, [8453, 42161]);
    expect(a).toEqual({ ownedChainIds: [8453], trackedChainIds: [8453, 42161], chat: false, ownersDiffer: false, unreadChainIds: [42161] });
  });
});

describe("listSafesForWallet", () => {
  let db: Db;
  let userId: number;
  beforeEach(async () => {
    db = await createTestDb();
    const { createSession } = await import("@/server/auth/session");
    userId = (await createSession(db, { address: owner.address.toLowerCase() as Address, chainId: 8453 })).userId;
    const [s] = await db.insert(safes).values({ address: SAFE, name: "Family Safe" }).returning();
    await db.insert(safeNetworks).values([{ safeId: s.id, chainId: 8453 }, { safeId: s.id, chainId: 42161 }]);
    await db.insert(userSafes).values({ userId, safeId: s.id });
  });

  it("drops a Safe after the wallet is removed as owner (once the cache expires)", async () => {
    const chain = fakeChain({ [`8453:${SAFE}`]: [owner.address], [`42161:${SAFE}`]: [owner.address] });
    let t = 0;
    const access = createAccess({ readOwners: chain.readOwners, cacheMs: 15000, now: () => t });
    const first = await listSafesForWallet(db, access, userId);
    expect(first.map((s) => s.address)).toEqual([SAFE]);
    chain.state[`8453:${SAFE}`] = [stranger.address];
    chain.state[`42161:${SAFE}`] = [stranger.address];
    t += 15001; // reload
    expect(await listSafesForWallet(db, access, userId)).toEqual([]);
  });

  it("keeps a Safe owned on one network and flags that owners differ", async () => {
    const chain = fakeChain({ [`8453:${SAFE}`]: [owner.address], [`42161:${SAFE}`]: [stranger.address] });
    const [s] = await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId);
    expect(s).toMatchObject({ ownedChainIds: [8453], ownersDiffer: true });
    await db.delete(userSafes).where(eq(userSafes.userId, userId));
    expect(await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId)).toEqual([]);
  });

  it("a Safe created in the app whose setup never finished is still listed, marked pending with its chosen networks", async () => {
    const NEW = "0x2222222222222222222222222222222222222222" as Address;
    const [row] = await db.insert(safes).values({
      address: NEW,
      name: "New Safe",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [8453, 100] },
    }).returning();
    await db.insert(safeNetworks).values([{ safeId: row.id, chainId: 8453 }, { safeId: row.id, chainId: 100 }]);
    await db.insert(userSafes).values({ userId, safeId: row.id });
    const chain = fakeChain({}); // nothing deployed: every owner read is null
    const list = await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId);
    const stalled = list.find((s) => s.address === NEW);
    expect(stalled).toMatchObject({ networks: [], ownedChainIds: [], pendingSetup: true });
    expect(stalled?.recordedChainIds).toEqual(expect.arrayContaining([8453, 100]));
    expect(stalled?.deployedChainIds).toEqual([]);
  });

  it("does not treat a missing on-chain owner result as proof of indexing lag", async () => {
    const NEW = "0x2222222222222222222222222222222222222222" as Address;
    const [row] = await db.insert(safes).values({
      address: NEW,
      name: "New Safe",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [8453] },
    }).returning();
    // The server marks deployed=true when it sees the code, before the Transaction Service has indexed the Safe.
    await db.insert(safeNetworks).values({ safeId: row.id, chainId: 8453, deployed: true });
    await db.insert(userSafes).values({ userId, safeId: row.id });
    const chain = fakeChain({}); // unindexed: owner reads still return null
    const list = await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId);
    expect(list.some((s) => s.address === NEW)).toBe(false);
  });

  it("a Safe owned on one network with another recorded network undeployed lists normally and stays resumable", async () => {
    const NEW = "0x2222222222222222222222222222222222222222" as Address;
    const [row] = await db.insert(safes).values({
      address: NEW,
      name: "New Safe",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [8453, 100] },
    }).returning();
    await db.insert(safeNetworks).values([{ safeId: row.id, chainId: 8453, deployed: true }, { safeId: row.id, chainId: 100 }]);
    await db.insert(userSafes).values({ userId, safeId: row.id });
    const chain = fakeChain({ [`8453:${NEW}`]: [owner.address] });
    const list = await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId);
    const partial = list.find((s) => s.address === NEW);
    expect(partial).toMatchObject({ networks: [8453], ownedChainIds: [8453], pendingSetup: true, deployedChainIds: [8453] });
    expect(partial?.recordedChainIds).toEqual(expect.arrayContaining([8453, 100]));
  });

  it("does not turn a removed setup owner into a pending Safe when every recorded network was deployed", async () => {
    const OLD = "0x3333333333333333333333333333333333333333" as Address;
    const [row] = await db.insert(safes).values({
      address: OLD,
      name: "Former Safe",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [8453, 42161] },
    }).returning();
    await db.insert(safeNetworks).values([{ safeId: row.id, chainId: 8453, deployed: true }, { safeId: row.id, chainId: 42161, deployed: true }]);
    await db.insert(userSafes).values({ userId, safeId: row.id });
    const chain = fakeChain({ [`8453:${OLD}`]: [stranger.address], [`42161:${OLD}`]: [stranger.address] });

    expect(await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId)).toEqual([]);
  });

  it("does not make an owned Safe pending because Settings recorded an extra network", async () => {
    const EXTRA = "0x4444444444444444444444444444444444444444" as Address;
    const [row] = await db.insert(safes).values({
      address: EXTRA,
      name: "Existing Safe",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [8453] },
    }).returning();
    await db.insert(safeNetworks).values([{ safeId: row.id, chainId: 8453, deployed: true }, { safeId: row.id, chainId: 42161, deployed: false }]);
    await db.insert(userSafes).values({ userId, safeId: row.id });
    const chain = fakeChain({ [`8453:${EXTRA}`]: [owner.address], [`42161:${EXTRA}`]: null });

    const saved = (await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId)).find((s) => s.address === EXTRA);
    expect(saved).toMatchObject({ ownedChainIds: [8453], pendingSetup: false });
  });

  it("uses the exact indexed lookup to keep an owned in-app Safe resumable during indexing lag", async () => {
    const NEW = "0x5555555555555555555555555555555555555555" as Address;
    const [row] = await db.insert(safes).values({
      address: NEW,
      name: "New Safe",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [8453] },
    }).returning();
    await db.insert(safeNetworks).values({ safeId: row.id, chainId: 8453, deployed: true });
    await db.insert(userSafes).values({ userId, safeId: row.id });
    const chain = fakeChain({ [`8453:${NEW}`]: [owner.address] });

    const [saved] = await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners, isIndexed: async () => false }), userId);
    expect(saved).toMatchObject({ ownedChainIds: [8453], pendingSetup: true, deployedChainIds: [8453] });
  });

  it("keeps an Ethereum-first Safe resumable when Arbitrum was not deployed yet", async () => {
    const ETH_FIRST = "0x6666666666666666666666666666666666666666" as Address;
    const [row] = await db.insert(safes).values({
      address: ETH_FIRST,
      name: "Ethereum first",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [1, 42161] },
    }).returning();
    await db.insert(safeNetworks).values([{ safeId: row.id, chainId: 1, deployed: true }, { safeId: row.id, chainId: 42161, deployed: false }]);
    await db.insert(userSafes).values({ userId, safeId: row.id });
    const chain = fakeChain({ [`42161:${ETH_FIRST}`]: null });

    const [saved] = await listSafesForWallet(db, createAccess({ readOwners: chain.readOwners }), userId, {
      readSetupOwners: async (chainId) => chainId === 1 ? [owner.address] : null,
    });
    expect(saved).toMatchObject({ pendingSetup: true, createdChainIds: [1, 42161], deployedChainIds: [1] });
  });

  it("keeps an established setup-only Safe visible only after live owner verification", async () => {
    const SETUP_ONLY = "0x7777777777777777777777777777777777777777" as Address;
    const [row] = await db.insert(safes).values({
      address: SETUP_ONLY,
      name: "Setup only",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1, createdChainIds: [10, 100] },
    }).returning();
    await db.insert(safeNetworks).values([{ safeId: row.id, chainId: 10, deployed: true }, { safeId: row.id, chainId: 100, deployed: false }]);
    await db.insert(userSafes).values({ userId, safeId: row.id });

    const currentOwner = await listSafesForWallet(db, createAccess({ readOwners: async () => null }), userId, {
      readSetupOwners: async (chainId) => chainId === 10 ? [owner.address] : null,
    });
    expect(currentOwner.find((s) => s.address === SETUP_ONLY)).toMatchObject({ pendingSetup: true, networks: [], createdChainIds: [10, 100] });

    const formerOwner = await listSafesForWallet(db, createAccess({ readOwners: async () => null }), userId, {
      readSetupOwners: async () => [stranger.address],
    });
    expect(formerOwner.some((s) => s.address === SETUP_ONLY)).toBe(false);
  });

  it("keeps legacy setup-only records usable after verifying ownership on a deployed setup network", async () => {
    const LEGACY = "0x8888888888888888888888888888888888888888" as Address;
    const [row] = await db.insert(safes).values({
      address: LEGACY,
      name: "Older setup",
      setup: { version: "1.4.1", singleton: SAFE, factory: SAFE, fallbackHandler: SAFE, saltNonce: "0", owners: [owner.address], threshold: 1 },
    }).returning();
    await db.insert(safeNetworks).values([{ safeId: row.id, chainId: 100, deployed: true }]);
    await db.insert(userSafes).values({ userId, safeId: row.id });

    const saved = await listSafesForWallet(db, createAccess({ readOwners: async () => null }), userId, {
      readSetupOwners: async () => [owner.address],
    });
    expect(saved.find((s) => s.address === LEGACY)).toMatchObject({ pendingSetup: false, createdChainIds: [100] });
  });
});

describe("auth route handlers", () => {
  it("nonce -> verify -> session -> logout, end to end", async () => {
    setDbForTests(await createTestDb());
    try {
      const host = "localhost:3000";
      const { nonce } = await (await nonceGET()).json();
      const message = buildSignInMessage({ domain: host, uri: `http://${host}`, chainId: 8453, address: owner.address, nonce });
      const signature = await owner.signMessage({ message });
      const post = (body: unknown) => new Request(`http://${host}/api/auth/verify`, { method: "POST", headers: { host }, body: JSON.stringify(body) });

      const res = await verifyPOST(post({ message, signature }));
      expect(res.status).toBe(200);
      expect((await res.json()).address).toBe(owner.address.toLowerCase());
      const setCookie = res.headers.get("set-cookie")!;
      expect(setCookie).toMatch(/^la_session=[0-9a-f]{64}; .*HttpOnly.*SameSite=Lax/);
      const cookie = setCookie.split(";")[0];

      expect((await verifyPOST(post({ message, signature }))).status).toBe(401); // nonce spent
      expect((await verifyPOST(post({}))).status).toBe(400);

      const req = () => new Request(`http://${host}/api/auth/session`, { headers: { cookie } });
      const s = await sessionGET(req());
      expect(s.status).toBe(200);
      expect((await s.json()).address).toBe(owner.address.toLowerCase());
      expect((await sessionGET(new Request(`http://${host}/api/auth/session`))).status).toBe(401);

      const out = await logoutPOST(req());
      expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await sessionGET(req())).status).toBe(401);
    } finally {
      setDbForTests(undefined);
    }
  });
});
