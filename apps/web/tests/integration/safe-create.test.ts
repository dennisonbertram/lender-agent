// BP-29, BP-30: one address on six networks (asserted on forks), relayer deploy on a fork, idempotency.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SAFE_NETWORKS } from "@/lib/safe-create";
import { createTestDb, type Db } from "@/server/db/test-db";
import { relayerDeployments, users } from "@/server/db/schema";
import { COMPATIBILITY_FALLBACK_HANDLER, SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY } from "@/server/safe/constants";
import { PROXY_CREATION_CODE, proxyFactoryAbi, predictSafeAddress, setupCalldata } from "@/server/safe/setup";
import { DEFAULT_BUDGET } from "@/lib/safe-create";
import { createDevRelayer } from "@/server/safe-create/relayer";
import { setupNetwork, type SetupDeps } from "@/server/safe-create/setup";
import { createSafeRecord, previewSafe } from "@/server/safe-create/store";
import { ANVIL_KEYS } from "../helpers/anvil";
import { startFork, type ChainFork } from "../helpers/multi-fork";
import { safeAbi } from "../helpers/safe";
import type { Address } from "@/shared/types";

const user = privateKeyToAccount(ANVIL_KEYS[0]);
const cosigner = privateKeyToAccount(ANVIL_KEYS[1]).address as Address;
const relayerKey = ANVIL_KEYS[4]; // not an owner: the relayer pays, the owners hold no funds
const forks = new Map<number, ChainFork>();

beforeAll(async () => {
  for (const n of SAFE_NETWORKS) forks.set(n.chainId, await startFork(n.chainId));
}, 600_000);
afterAll(async () => { await Promise.all([...forks.values()].map((f) => f.stop())); });

describe("one address on six networks (BP-29)", () => {
  it("the predicted address is what the factory returns on every network, and the pinned contracts match", async () => {
    const db = await createTestDb();
    const pv = await previewSafe(db, { creator: user.address, name: "My Safe", cosigners: [cosigner], threshold: 1 });
    for (const n of SAFE_NETWORKS) {
      const { publicClient } = forks.get(n.chainId)!;
      for (const a of [SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY, COMPATIBILITY_FALLBACK_HANDLER]) {
        const code = await publicClient.getCode({ address: a });
        expect(code && code.length > 2, `${n.name} ${a}`).toBe(true);
      }
      expect(await publicClient.readContract({ address: SAFE_PROXY_FACTORY, abi: proxyFactoryAbi, functionName: "proxyCreationCode" }), n.name).toBe(PROXY_CREATION_CODE);
      const { result } = await publicClient.simulateContract({
        address: SAFE_PROXY_FACTORY, abi: proxyFactoryAbi, functionName: "createProxyWithNonce",
        args: [pv.setup.singleton, setupCalldata(pv.setup), BigInt(pv.setup.saltNonce)], account: relayerKeyAddress(),
      });
      expect(getAddress(result), n.name).toBe(pv.address);
    }
  });
});

function relayerKeyAddress() { return privateKeyToAccount(relayerKey).address; }

describe("setup by the relayer on two forks (BP-29, BP-30)", () => {
  let db: Db;
  let deps: SetupDeps;
  beforeAll(async () => {
    db = await createTestDb();
    await db.insert(users).values({ address: user.address.toLowerCase() });
    const relayer = createDevRelayer({ key: relayerKey, clientsFor: (id) => { const f = forks.get(id)!; return { publicClient: f.publicClient, walletClient: f.walletClient, chain: f.chain }; } });
    deps = {
      db, relayer, budget: DEFAULT_BUDGET,
      hasCode: async (id, a) => { const c = await forks.get(id)!.publicClient.getCode({ address: a }); return !!c && c !== "0x"; },
      getLiveSetup: async (id, a) => {
        const client = forks.get(id)!.publicClient;
        const code = await client.getCode({ address: a });
        if (!code || code === "0x") return null;
        const [owners, threshold] = await Promise.all([
          client.readContract({ address: a, abi: safeAbi, functionName: "getOwners" }),
          client.readContract({ address: a, abi: safeAbi, functionName: "getThreshold" }),
        ]);
        return { owners: [...owners], threshold: Number(threshold) };
      },
      receiptStatus: async () => "pending",
      // The hosted Transaction Service is not part of the fork: indexed once the code is there.
      isIndexed: async (id, a) => { const c = await forks.get(id)!.publicClient.getCode({ address: a }); return !!c && c !== "0x"; },
    };
  });

  it("deploys at the address Review showed, on Base then Optimism, with the original owners; a second call is a no-op", async () => {
    const [u] = await db.select().from(users);
    const input = { name: "My Safe", cosigners: [cosigner as string], threshold: 1 };
    const pv = await previewSafe(db, { creator: user.address, ...input });
    const signature = await user.signMessage({ message: pv.message });
    const rec = await createSafeRecord(db, { userId: u.id, creator: user.address, ...input, index: pv.index, signature, networks: [8453, 10] });
    expect(rec.address).toBe(pv.address);

    for (const chainId of [8453, 10]) {
      const f = forks.get(chainId)!;
      const before = await f.publicClient.getBalance({ address: user.address });
      const r = await setupNetwork(deps, { address: rec.address, chainId });
      expect(r).toMatchObject({ status: "ready", deployed: "by_relayer", indexed: true });
      // The deployed Safe is at the address shown, has the original owners and threshold, and the user paid nothing.
      expect(await f.publicClient.readContract({ address: rec.address, abi: safeAbi, functionName: "getOwners" })).toEqual(pv.setup.owners);
      expect(await f.publicClient.readContract({ address: rec.address, abi: safeAbi, functionName: "getThreshold" })).toBe(1n);
      expect(await f.publicClient.getBalance({ address: user.address })).toBe(before);

      const nonceBefore = await f.publicClient.getTransactionCount({ address: relayerKeyAddress() });
      expect(await setupNetwork(deps, { address: rec.address, chainId })).toMatchObject({ status: "ready", deployed: "already", txHash: null });
      expect(await f.publicClient.getTransactionCount({ address: relayerKeyAddress() })).toBe(nonceBefore); // nothing sent
    }
    expect(await db.select().from(relayerDeployments)).toHaveLength(2);
    expect(predictSafeAddress(pv.setup)).toBe(rec.address);
  });

  it("with no budget, the user's own transaction deploys the same address (user pays path)", async () => {
    const [u] = await db.select().from(users);
    const pv = await previewSafe(db, { creator: user.address, name: "Second", cosigners: [], threshold: 1 });
    const signature = await user.signMessage({ message: pv.message });
    const rec = await createSafeRecord(db, { userId: u.id, creator: user.address, name: "Second", cosigners: [], threshold: 1, index: pv.index, signature, networks: [100] });
    const zero = { ...deps, budget: { ...DEFAULT_BUDGET, daily: 0 } };
    const r = await setupNetwork(zero, { address: rec.address, chainId: 100 });
    if (r.status !== "user_pays") throw new Error("expected user_pays");
    expect(r.cost).not.toMatch(/free/i);
    const f = forks.get(100)!;
    const hash = await f.walletClient.sendTransaction({ account: user, chain: f.chain, to: r.tx.to, data: r.tx.data });
    await f.publicClient.waitForTransactionReceipt({ hash });
    expect(await setupNetwork(zero, { address: rec.address, chainId: 100, userTxHash: hash })).toMatchObject({ status: "ready", deployed: "already" });
    expect(await f.publicClient.getCode({ address: rec.address })).toBeTruthy();
  });
});
