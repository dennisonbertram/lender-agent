import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTestDb, type Db } from "@/server/db/test-db";
import { operatorAlerts, relayerDeployments, safeNetworks, safes, users } from "@/server/db/schema";
import { DEFAULT_BUDGET } from "@/lib/safe-create";
import { SAFE_L2_SINGLETON } from "@/server/safe/constants";
import { deploymentCalldata, predictSafeAddress } from "@/server/safe/setup";
import { ANVIL_KEYS } from "../../../tests/helpers/anvil";
import { consentMessage, planSafe } from "./plan";
import { RELAYER_BALANCE_LOW, checkRelayerBalance } from "./alerts";
import { RelayerNotConfigured, envClients, stubRelayer, type Relayer } from "./relayer";
import { ENABLED_CHAIN_IDS, SAFE_NETWORKS } from "@/lib/safe-create";
import { networksNeedingSetup, setupNetwork, type SetupDeps } from "./setup";
import { createSafeRecord, previewSafe } from "./store";
import type { Address } from "@/shared/types";

const user = privateKeyToAccount(ANVIL_KEYS[0]);
const co = privateKeyToAccount(ANVIL_KEYS[1]).address;

describe("planSafe", () => {
  it("pins SafeL2 1.4.1 and the stored salt, user first", () => {
    const { setup, address } = planSafe({ name: " My Safe ", creator: user.address, cosigners: [co], threshold: 1, index: 0 });
    expect(setup.singleton).toBe(SAFE_L2_SINGLETON);
    expect(setup.version).toBe("1.4.1");
    expect(setup.owners).toEqual([user.address, co]);
    expect(address).toBe(predictSafeAddress(setup));
  });
  it("rejects bad owners and thresholds with the form's text", () => {
    expect(() => planSafe({ name: "A", creator: user.address, cosigners: [user.address], threshold: 1, index: 0 })).toThrow(/your address/);
    expect(() => planSafe({ name: "A", creator: user.address, cosigners: ["0x12"], threshold: 1, index: 0 })).toThrow(/not a valid address/);
    expect(() => planSafe({ name: "A", creator: user.address, cosigners: [co], threshold: 3, index: 0 })).toThrow(/between 1 and/);
    expect(() => planSafe({ name: " ", creator: user.address, cosigners: [], threshold: 1, index: 0 })).toThrow(/name/);
  });
  it("a different salt index gives a different address; the same input is stable", () => {
    const a = planSafe({ name: "A", creator: user.address, cosigners: [], threshold: 1, index: 0 });
    expect(planSafe({ name: "A", creator: user.address, cosigners: [], threshold: 1, index: 0 }).address).toBe(a.address);
    expect(planSafe({ name: "A", creator: user.address, cosigners: [], threshold: 1, index: 1 }).address).not.toBe(a.address);
  });
});

describe("create and set up", () => {
  let db: Db;
  let userId: number;
  beforeEach(async () => {
    db = await createTestDb();
    [{ id: userId }] = await db.insert(users).values({ address: user.address.toLowerCase() }).returning({ id: users.id });
  });

  const create = async (over: Partial<Parameters<typeof createSafeRecord>[1]> = {}) => {
    const input = { name: "My Safe", cosigners: [co as string], threshold: 1 };
    const pv = await previewSafe(db, { creator: user.address, ...input });
    const signature = await user.signMessage({ message: pv.message });
    return { pv, rec: await createSafeRecord(db, { userId, creator: user.address, ...input, index: pv.index, signature, networks: [8453], ...over }) };
  };

  it("stores the original setup, the salt and the creator's signature; the preview address is the stored one", async () => {
    const { pv, rec } = await create();
    expect(rec.address).toBe(pv.address);
    const [row] = await db.select().from(safes);
    expect(row.address).toBe(pv.address.toLowerCase());
    expect(row.setup).toMatchObject({ ...pv.setup, createdChainIds: [8453] });
    expect(rec.setup.createdChainIds).toEqual([8453]);
    expect(predictSafeAddress(rec.setup)).toBe(pv.address);
    expect(deploymentCalldata(rec.setup)).toBe(deploymentCalldata(pv.setup));
    expect(await db.select().from(safeNetworks)).toMatchObject([{ chainId: 8453, deployed: false }]);
  });

  it("refuses a signature from anyone but the creator, and creates nothing", async () => {
    const pv = await previewSafe(db, { creator: user.address, name: "My Safe", cosigners: [], threshold: 1 });
    const other = privateKeyToAccount(ANVIL_KEYS[2]);
    const signature = await other.signMessage({ message: consentMessage({ name: pv.name, address: pv.address, setup: pv.setup }) });
    await expect(createSafeRecord(db, { userId, creator: user.address, name: "My Safe", cosigners: [], threshold: 1, index: pv.index, signature, networks: [8453] }, { client: { verifyMessage: async () => false } })).rejects.toThrow(/signature/);
    expect(await db.select().from(safes)).toHaveLength(0);
  });

  it("the second Safe of the same wallet gets the next salt index and another address", async () => {
    const a = await create();
    const b = await create();
    expect(b.pv.index).toBe(a.pv.index + 1);
    expect(b.rec.address).not.toBe(a.rec.address);
  });

  it("refuses an unsupported network", async () => {
    await expect(create({ networks: [56] })).rejects.toThrow(/network/);
  });

  // A tiny chain: the Safe exists once `deploy` has run.
  const world = (over: Partial<SetupDeps> & { relayer?: Relayer } = {}) => {
    const deployed = new Set<string>();
    const liveSetups = new Map<string, { owners: `0x${string}`[]; threshold: number }>();
    const sent: number[] = [];
    const relayer: Relayer = over.relayer ?? {
      address: "0x000000000000000000000000000000000000dEaD",
      balance: async () => 10n ** 18n,
      estimate: async () => 1_000_000n,
      deploy: async (chainId, setup) => { await new Promise((r) => setTimeout(r, 5)); sent.push(chainId); deployed.add(`${chainId}:${predictSafeAddress(setup).toLowerCase()}`); liveSetups.set(`${chainId}:${predictSafeAddress(setup).toLowerCase()}`, { owners: setup.owners, threshold: setup.threshold }); return { txHash: "0xabc" as Hex, costWei: 900_000n }; },
    };
    const deps: SetupDeps = {
      db, relayer, budget: DEFAULT_BUDGET,
      hasCode: async (c, a) => deployed.has(`${c}:${a.toLowerCase()}`),
      getLiveSetup: async (c, a) => liveSetups.get(`${c}:${a.toLowerCase()}`) ?? null,
      receiptStatus: async () => "success",
      isIndexed: async (c, a) => deployed.has(`${c}:${a.toLowerCase()}`),
      ...over,
    };
    return { deps, sent, deployed };
  };

  it("relayer deploys once; a second call is a no-op", async () => {
    const { rec } = await create();
    const { deps, sent } = world();
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "ready", deployed: "by_relayer", txHash: "0xabc", indexed: true });
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "ready", deployed: "already", txHash: null });
    expect(sent).toEqual([8453]);
    expect(await db.select().from(relayerDeployments)).toHaveLength(1);
    expect(await db.select().from(safeNetworks)).toMatchObject([{ deployed: true }]);
  });

  it("a plan that needs another network gets setup, then the agent signature, for that network only", async () => {
    const { rec } = await create({ networks: [8453, 10] });
    const { deps } = world();
    await setupNetwork(deps, { address: rec.address, chainId: 8453 });
    await db.update(safeNetworks).set({ agentAdded: true }).where(eq(safeNetworks.chainId, 8453));
    expect(await networksNeedingSetup(db, rec.address, [8453])).toEqual([]);
    expect(await networksNeedingSetup(db, rec.address, [8453, 10])).toEqual([{ chainId: 10, needs: ["setup", "agent"] }]);
    expect((await setupNetwork(deps, { address: rec.address, chainId: 10 })).status).toBe("ready");
    expect(await networksNeedingSetup(db, rec.address, [10])).toEqual([{ chainId: 10, needs: ["agent"] }]);
  });

  it("two simultaneous calls send once", async () => {
    const { rec } = await create();
    const { deps, sent } = world();
    const r = await Promise.all([setupNetwork(deps, { address: rec.address, chainId: 8453 }), setupNetwork(deps, { address: rec.address, chainId: 8453 })]);
    expect(sent).toHaveLength(1);
    expect(r.filter((x) => x.status === "ready").length).toBeGreaterThanOrEqual(1);
  });

  it("a failed send frees the slot so a retry can deploy", async () => {
    const { rec } = await create();
    let fail = true;
    const base = world();
    const relayer: Relayer = { ...base.deps.relayer, deploy: async (c, s) => { if (fail) throw new Error("rpc down"); return base.deps.relayer.deploy(c, s); } };
    const deps = { ...base.deps, relayer };
    await expect(setupNetwork(deps, { address: rec.address, chainId: 8453 })).rejects.toThrow("rpc down");
    expect(await db.select().from(relayerDeployments)).toHaveLength(0);
    fail = false;
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "ready" });
  });

  const otherCreate = async (key: (typeof ANVIL_KEYS)[number], name = "Other") => {
    const acct = privateKeyToAccount(key);
    const [{ id }] = await db.insert(users).values({ address: acct.address.toLowerCase() }).returning({ id: users.id });
    const input = { name, cosigners: [] as string[], threshold: 1 };
    const pv = await previewSafe(db, { creator: acct.address, ...input });
    const signature = await acct.signMessage({ message: pv.message });
    return createSafeRecord(db, { userId: id, creator: acct.address, ...input, index: pv.index, signature, networks: [8453] });
  };

  it("review 1: concurrent setups for different Safes cannot pass the daily budget together", async () => {
    const a = await create();
    const b = await otherCreate(ANVIL_KEYS[2]);
    const { deps, sent } = world({ budget: { ...DEFAULT_BUDGET, daily: 1 } });
    const r = await Promise.all([setupNetwork(deps, { address: a.rec.address, chainId: 8453 }), setupNetwork(deps, { address: b.address, chainId: 8453 })]);
    expect(sent).toHaveLength(1);
    expect(r.map((x) => x.status).sort()).toEqual(["ready", "user_pays"]);
  });

  it("review 2: one wallet cannot drain the allowance with many Safes", async () => {
    const a = await create();
    const b = await create();
    const { deps, sent } = world({ budget: { ...DEFAULT_BUDGET, perCreator: 1 } });
    expect((await setupNetwork(deps, { address: a.rec.address, chainId: 8453 })).status).toBe("ready");
    expect(await setupNetwork(deps, { address: b.rec.address, chainId: 8453 })).toMatchObject({ status: "user_pays", reason: "creator_limit" });
    expect(sent).toHaveLength(1);
  });

  it("review 3: refuses sponsorship when the gas estimate is above the per-deployment ceiling", async () => {
    const { rec } = await create();
    const base = world();
    const deps = { ...base.deps, budget: { ...DEFAULT_BUDGET, maxCostWei: 1000n }, relayer: { ...base.deps.relayer, estimate: async () => 1001n } };
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "user_pays", reason: "cost_too_high" });
    expect(base.sent).toEqual([]);
    expect(await db.select().from(relayerDeployments)).toHaveLength(0);
  });

  it("review 3: the actual cost counts against a daily spend cap", async () => {
    const a = await create();
    const b = await create();
    const { deps, sent } = world({ budget: { ...DEFAULT_BUDGET, perCreator: 10, dailySpendWei: 1_500_000n } });
    expect((await setupNetwork(deps, { address: a.rec.address, chainId: 8453 })).status).toBe("ready");
    const [row] = await db.select().from(relayerDeployments);
    expect(row.costWei).toBe("900000");
    // 900k spent; the next estimate of 1M would pass the cap of 1.5M, so it is refused.
    expect(await setupNetwork(deps, { address: b.rec.address, chainId: 8453 })).toMatchObject({ status: "user_pays", reason: "daily_spend_limit" });
    expect(sent).toHaveLength(1);
  });

  it("review 3: a Safe is capped at 10 owners", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `0x${"ab".repeat(19)}${(i + 1).toString(16).padStart(2, "0")}`);
    expect(planSafe({ name: "A", creator: user.address, cosigners: many(9), threshold: 1, index: 0 }).setup.owners).toHaveLength(10);
    expect(() => planSafe({ name: "A", creator: user.address, cosigners: many(10), threshold: 1, index: 0 })).toThrow(/at most 10/);
  });

  it("review 5: a claim whose lease expired before broadcast is resumed", async () => {
    const { rec } = await create();
    await db.insert(relayerDeployments).values({ safeId: rec.safeId, chainId: 8453, creator: user.address.toLowerCase(), leaseExpiresAt: new Date(Date.now() - 1000) });
    const { deps, sent } = world();
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "ready", deployed: "by_relayer" });
    expect(sent).toEqual([8453]);
  });

  it("a resumed claim is re-checked against the current estimate: over the ceiling, the user pays and nothing is sent", async () => {
    const { rec } = await create();
    await db.insert(relayerDeployments).values({ safeId: rec.safeId, chainId: 8453, creator: user.address.toLowerCase(), estimatedWei: "1000", leaseExpiresAt: new Date(Date.now() - 1000) });
    const { deps, sent } = world();
    const pricey: Relayer = { ...deps.relayer, estimate: async () => DEFAULT_BUDGET.maxCostWei + 1n };
    expect(await setupNetwork({ ...deps, relayer: pricey }, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "user_pays", reason: "cost_too_high" });
    expect(sent).toEqual([]);
  });

  it("a claim resumed on a later day counts against that day's spend, with a fresh estimate and date", async () => {
    const { rec } = await create();
    const { rec: other } = await create();
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await db.insert(relayerDeployments).values({ safeId: rec.safeId, chainId: 8453, creator: user.address.toLowerCase(), estimatedWei: "1000", leaseExpiresAt: yesterday, createdAt: yesterday });
    await db.insert(relayerDeployments).values({ safeId: other.safeId, chainId: 8453, creator: user.address.toLowerCase(), estimatedWei: "1000000", leaseExpiresAt: new Date(Date.now() + 60_000) });
    const tight = world({ budget: { ...DEFAULT_BUDGET, dailySpendWei: 1_500_000n } });
    expect(await setupNetwork(tight.deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "user_pays", reason: "daily_spend_limit" });
    expect(tight.sent).toEqual([]);
    const ok = world();
    await db.insert(relayerDeployments).values({ safeId: rec.safeId, chainId: 8453, creator: user.address.toLowerCase(), estimatedWei: "1000", leaseExpiresAt: yesterday, createdAt: yesterday }).onConflictDoNothing();
    expect(await setupNetwork(ok.deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "ready", deployed: "by_relayer" });
    const [row] = await db.select().from(relayerDeployments).where(eq(relayerDeployments.safeId, rec.safeId));
    expect(row.createdAt.getTime()).toBeGreaterThan(yesterday.getTime() + 3600_000);
  });

  it("review 5: an expired claim whose Safe already has code is reconciled without sending", async () => {
    const { rec } = await create();
    await db.insert(relayerDeployments).values({ safeId: rec.safeId, chainId: 8453, creator: user.address.toLowerCase(), leaseExpiresAt: new Date(Date.now() - 1000) });
    const { deps, sent, deployed } = world();
    deployed.add(`8453:${rec.address.toLowerCase()}`);
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "ready", deployed: "already" });
    expect(sent).toEqual([]);
  });

  it("review 5: a live lease is still pending", async () => {
    const { rec } = await create();
    await db.insert(relayerDeployments).values({ safeId: rec.safeId, chainId: 8453, creator: user.address.toLowerCase(), leaseExpiresAt: new Date(Date.now() + 60_000) });
    const { deps, sent } = world();
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toEqual({ status: "pending" });
    expect(sent).toEqual([]);
  });

  it("review 7: an identical signed retry returns the existing record; a different request is 409", async () => {
    const first = await create();
    const input = { name: "My Safe", cosigners: [co as string], threshold: 1 };
    const signature = await user.signMessage({ message: first.pv.message });
    const again = await createSafeRecord(db, { userId, creator: user.address, ...input, index: first.pv.index, signature, networks: [8453] });
    expect(again).toMatchObject({ safeId: first.rec.safeId, address: first.rec.address, networks: [8453] });
    expect(await db.select().from(safes)).toHaveLength(1);
    // Same index, different owners: a different request.
    const other = { ...input, cosigners: [] as string[] };
    const pv2 = await previewSafe(db, { creator: user.address, ...other });
    const sig2 = await user.signMessage({ message: consentMessage({ name: "My Safe", address: planSafe({ ...other, creator: user.address, index: first.pv.index }).address, setup: planSafe({ ...other, creator: user.address, index: first.pv.index }).setup }) });
    void pv2;
    await expect(createSafeRecord(db, { userId, creator: user.address, ...other, index: first.pv.index, signature: sig2, networks: [8453] })).rejects.toMatchObject({ status: 409 });
  });

  it("with the budget at zero the user is told the fee and nothing is sent", async () => {
    const { rec } = await create();
    const { deps, sent } = world({ budget: { ...DEFAULT_BUDGET, daily: 0 } });
    const r = await setupNetwork(deps, { address: rec.address, chainId: 8453 });
    expect(r).toMatchObject({ status: "user_pays", reason: "budget_off" });
    if (r.status !== "user_pays") throw new Error();
    expect(r.cost).not.toMatch(/free/i);
    expect(r.cost).toMatch(/one-time/);
    expect(r.tx.data).toMatch(/^0x1688f0b9/); // createProxyWithNonce
    expect(sent).toEqual([]);
  });

  it("Ethereum is not sponsored: the user pays", async () => {
    const { rec } = await create({ networks: [1] });
    const { deps } = world();
    expect(await setupNetwork(deps, { address: rec.address, chainId: 1 })).toMatchObject({ status: "user_pays", reason: "network_not_sponsored" });
  });

  it("the per-Safe limit stops a third sponsored network", async () => {
    const { rec } = await create({ networks: [8453, 10, 42161] });
    const { deps } = world();
    expect((await setupNetwork(deps, { address: rec.address, chainId: 8453 })).status).toBe("ready");
    expect((await setupNetwork(deps, { address: rec.address, chainId: 10 })).status).toBe("ready");
    expect(await setupNetwork(deps, { address: rec.address, chainId: 42161 })).toMatchObject({ status: "user_pays", reason: "safe_limit" });
  });

  it("the stub production relayer refuses ('not configured'), and setup then asks the user to pay, never saying free", async () => {
    await expect(stubRelayer.deploy(8453, planSafe({ name: "A", creator: user.address, cosigners: [], threshold: 1, index: 0 }).setup)).rejects.toThrow("not configured");
    await expect(stubRelayer.deploy(8453, planSafe({ name: "A", creator: user.address, cosigners: [], threshold: 1, index: 0 }).setup)).rejects.toBeInstanceOf(RelayerNotConfigured);
    const { rec } = await create();
    const { deps } = world({ relayer: stubRelayer });
    const r = await setupNetwork(deps, { address: rec.address, chainId: 8453 });
    expect(r).toMatchObject({ status: "user_pays", reason: "relayer_unavailable" });
    expect((r as { cost: string }).cost).not.toMatch(/free/i);
  });

  it("all six networks are enabled, and a Safe can be created on all of them", async () => {
    expect(ENABLED_CHAIN_IDS).toEqual(SAFE_NETWORKS.map((n) => n.chainId));
    const { rec } = await create({ networks: ENABLED_CHAIN_IDS });
    expect((await db.select().from(safeNetworks)).map((n) => n.chainId).sort((a, b) => a - b)).toEqual([...ENABLED_CHAIN_IDS].sort((a, b) => a - b));
    expect(rec.address).toBeTruthy();
  });

  it("with no relayer, each network asks the user to pay the same stored setup; confirmation reads that network's own chain", async () => {
    const { rec } = await create({ networks: ENABLED_CHAIN_IDS });
    const { deps, deployed } = world({ relayer: stubRelayer });
    const calldata = new Set<string>();
    for (const id of ENABLED_CHAIN_IDS) {
      const r = await setupNetwork(deps, { address: rec.address, chainId: id });
      expect(r).toMatchObject({ status: "user_pays", reason: "relayer_unavailable" });
      if (r.status !== "user_pays") throw new Error();
      expect(r.cost).toContain(SAFE_NETWORKS.find((n) => n.chainId === id)!.name);
      calldata.add(r.tx.data);
    }
    expect(calldata.size).toBe(1); // one setup, one address on every network
    // The user pays on Ethereum only: that confirms Ethereum, and Base still asks for payment.
    deployed.add(`1:${rec.address.toLowerCase()}`);
    expect(await setupNetwork(deps, { address: rec.address, chainId: 1, userTxHash: "0xabc" as Hex })).toMatchObject({ status: "ready", deployed: "already" });
    await expect(setupNetwork(deps, { address: rec.address, chainId: 8453, userTxHash: "0xabc" as Hex })).rejects.toThrow(/payment confirmed/);
    expect((await db.select().from(safeNetworks)).filter((n) => n.deployed).map((n) => n.chainId)).toEqual([1]);
  });

  it("a confirmed failed user payment is reported as reverted and allows a deliberate fee retry", async () => {
    const { rec } = await create();
    const { deps } = world({
      relayer: stubRelayer,
      receiptStatus: async () => "reverted",
    });
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453, userTxHash: "0xabc" as Hex })).toMatchObject({ status: "reverted" });
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453 })).toMatchObject({ status: "user_pays" });
  });

  it("a pending user transaction never returns another fee prompt", async () => {
    const { rec } = await create();
    const { deps } = world({ relayer: stubRelayer, receiptStatus: async () => "pending" });
    expect(await setupNetwork(deps, { address: rec.address, chainId: 8453, userTxHash: "0xabc" as Hex })).toMatchObject({ status: "pending" });
  });

  it("does not deploy another network with a stored signer removed from an already deployed network", async () => {
    const { rec } = await create({ networks: [8453, 42161] });
    const liveOwners = new Map<number, { owners: Address[]; threshold: number }>();
    liveOwners.set(8453, { owners: [user.address], threshold: 1 });
    await db.update(safeNetworks).set({ deployed: true }).where(eq(safeNetworks.safeId, rec.safeId));
    const { deps, sent } = world({
      getLiveSetup: async (chainId) => liveOwners.get(chainId) ?? null,
    });
    await expect(setupNetwork(deps, { address: rec.address, chainId: 42161 })).rejects.toThrow(/owners or approval threshold changed/i);
    expect(sent).toEqual([]);
  });

  it("RPCs: each network has a public default, RPC_URL_<chainId> overrides it", () => {
    for (const id of ENABLED_CHAIN_IDS) {
      const c = envClients(id, {});
      expect(c.chain.id).toBe(id);
      expect(c.publicClient.transport.url ?? c.publicClient.chain?.rpcUrls.default.http[0]).toBeTruthy();
    }
    expect(envClients(1, { RPC_URL_1: "https://eth.example" }).publicClient.transport.url).toBe("https://eth.example");
    expect(envClients(100, {}).publicClient.transport.url).toBe(envClients(100, {}).chain.rpcUrls.default.http[0]);
    expect(() => envClients(5, {})).toThrow(/not supported/);
  });

  it("M5: a low relayer balance raises one alert, and resolves it when topped up", async () => {
    let bal = 1n;
    const relayer: Relayer = { address: "0x000000000000000000000000000000000000dEaD", balance: async () => bal, estimate: async () => 1n, deploy: async () => { throw new Error("n/a"); } };
    const opts = { chainIds: [8453], minWei: 1000n };
    expect(await checkRelayerBalance(db, relayer, opts)).toEqual([8453]);
    expect(await checkRelayerBalance(db, relayer, opts)).toEqual([8453]);
    let open = (await db.select().from(operatorAlerts)).filter((a) => !a.resolvedAt);
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe(`${RELAYER_BALANCE_LOW}:8453`);
    bal = 10n ** 18n;
    expect(await checkRelayerBalance(db, relayer, opts)).toEqual([]);
    open = (await db.select().from(operatorAlerts)).filter((a) => !a.resolvedAt);
    expect(open).toHaveLength(0);
  });
});
