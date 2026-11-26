// BP-39 and BP-40 on a Base fork: link a Reserve Safe through the app's own path (check, build, store as a
// proposal on the Reserve Safe, propose through the fake Transaction Service), execute what was stored as
// the owners would, and read the policy and status back from chain with the real Roles v2 contracts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseUnits, toHex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { setPublicClientForTests } from "@/server/chain/client";
import { createViemReader } from "@/server/chain/reader";
import { proposals, reserveLinks } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { chainTestRunDeps, testRun } from "@/server/proposals/test-run";
import { buildReserveSetup, buildRoleRepay, clearReserveCache, DevExecutorSigner, linkReserve, reservePolicy, reserveStatus, RESERVE_ASSET, ROLE_KEY, sendRoleCall } from "@/server/reserve";
import { rolesAbi } from "@/server/reserve/roles-abi";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import { erc20Abi } from "@/server/chain/abis";
import type { Spec } from "@/lib/proposals";
import type { Address, Hex, SafeTx } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { createTestWorld, type TestWorld } from "../helpers/world";

const { usdc: USDC } = RESERVE_ASSET[8453]!;
const executor = new DevExecutorSigner(ANVIL_KEYS[2]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

let fork: Fork;
let client: PublicClient;
let w: TestWorld;
let main: Address;
let reserve: Address;
let snap: Hex;
let fromBlockNow: bigint;

async function setUsdc(who: Address, value: bigint) {
  const index = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
  await fork.testClient.setStorageAt({ address: USDC, index, value: toHex(value, { size: 32 }) });
}
const days = async (n: number) => { await fork.testClient.increaseTime({ seconds: Math.round(n * 86_400) }); await fork.testClient.mine({ blocks: 1 }); };

beforeAll(async () => {
  let last: unknown;
  for (let i = 0; i < 3 && !fork; i++) {
    try { fork = await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  if (!fork) throw last;
  client = fork.publicClient as PublicClient;
  setPublicClientForTests(8453, client);
  // Main Safe with a real Aave debt, owned by the mock owner (anvil key 1).
  main = (await deployTestSafe({ fork, owners: [MOCK_OWNER], threshold: 1, saltNonce: "9200" })).address;
  await fork.testClient.setBalance({ address: main, value: parseUnits("10", 18) });
  const spec: Spec = { kind: "open", venueId: "aave", asset: "ETH", amount: 3, borrow: 2000, safeId: "s", network: "base" };
  const open = await testRun({ chainId: 8453, safe: main, spec, healthBefore: null, atRiskLevel: 1.35 });
  expect((await execSafeTx(fork, main, open.tx, [ANVIL_KEYS[1]])).success).toBe(true);
  await setUsdc(main, 0n);
  reserve = (await deployTestSafe({ fork, owners: [MOCK_OWNER], threshold: 1, saltNonce: "9201" })).address;
  await setUsdc(reserve, parseUnits("5000", 6));
  await fork.testClient.setBalance({ address: executor.address, value: parseUnits("1", 18) });
  fromBlockNow = (await client.getBlockNumber());
  snap = await fork.testClient.snapshot();
}, 300_000);
afterAll(async () => { setPublicClientForTests(8453, undefined); await fork?.stop(); });

beforeEach(async () => {
  await fork.testClient.revert({ id: snap });
  snap = await fork.testClient.snapshot();
  clearReserveCache();
  w = await createTestWorld();
  w.services.reader = createViemReader();
  w.services.testRunDeps = chainTestRunDeps;
});
afterEach(() => w.reset());

async function ctxFor() {
  await w.trackSafe(main, { name: "Treasury Safe", agentAdded: true });
  const fake = w.services.fakes.get(8453)!;
  for (const s of [main, reserve]) {
    fake.setOwners(s, [MOCK_OWNER], 1);
    w.services.fixture.setOwners(8453, s, [MOCK_OWNER], 1);
    const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
    await fake.addDelegate({ safe: s, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
  }
  const { cookie } = await w.signIn(MOCK_OWNER);
  return safeContext(w.req("/", { cookie }), main, w.services);
}
const input = (o: Partial<{ dailyLimitUsd: number; triggerHf: number; reserveSafe: string }> = {}) => ({ chainId: 8453 as const, reserveSafe: reserve, dailyLimitUsd: 1000, triggerHf: 1.15, ...o });

describe("BP-39: limits are checked before signing", () => {
  it("blocks a limit above the Reserve balance or below $1, and a trigger outside 1.02 to 2.00, with the messages", async () => {
    const ctx = await ctxFor();
    await expect(linkReserve(ctx, input({ dailyLimitUsd: 6000 }))).rejects.toThrow("The Reserve Safe holds $5,000. The limit cannot be higher.");
    await expect(linkReserve(ctx, input({ dailyLimitUsd: 0.5 }))).rejects.toThrow("Enter at least $1.");
    await expect(linkReserve(ctx, input({ dailyLimitUsd: 0 }))).rejects.toThrow("Enter at least $1.");
    await expect(linkReserve(ctx, input({ triggerHf: 1.01 }))).rejects.toThrow("Use a number from 1.02 to 2.00");
    await expect(linkReserve(ctx, input({ triggerHf: 2.5 }))).rejects.toThrow("Use a number from 1.02 to 2.00");
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    expect(await w.db.select().from(reserveLinks)).toHaveLength(0);
  });
  it("refuses the main Safe as its own Reserve and a Reserve the wallet does not own", async () => {
    const ctx = await ctxFor();
    await expect(linkReserve(ctx, input({ reserveSafe: main }))).rejects.toThrow("different Safe");
    const other = (await deployTestSafe({ fork, owners: [privateKeyToAccount(ANVIL_KEYS[4]).address], threshold: 1, saltNonce: "9202" })).address;
    await expect(linkReserve(ctx, input({ reserveSafe: other }))).rejects.toThrow("not an owner");
  });
  it("needs the agent on the Reserve Safe (the proposal path), and never uses the proposer key as the executor", async () => {
    const ctx = await ctxFor();
    await expect(linkReserve(ctx, input(), { executor: { address: w.services.signer.address, signRoleCall: async () => "0x" } })).rejects.toThrow("proposer");
  });
});

describe("BP-39: sign the policy, read it back from chain", () => {
  it("queues the setup on the Reserve Safe through the proposal path; after the owners sign, policy and status are decoded from chain", async () => {
    const ctx = await ctxFor();
    const r = await linkReserve(ctx, input());
    expect(r.stage).toBe("queued");
    expect(r.executor.toLowerCase()).toBe(executor.address.toLowerCase());
    expect(r.executor.toLowerCase()).not.toBe(w.services.signer.address.toLowerCase());
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(row!.stage).toBe("queued");
    const tx = row!.tx as SafeTx;
    expect(tx.operation).toBe(1); // MultiSendCallOnly
    // Before the owners sign: linked, but Off, and the policy says why.
    const pending = (await reservePolicy({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 }))!;
    expect(pending.armed).toBe(false);
    expect((await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 }))!.label).toBe("Off");

    expect((await execSafeTx(fork, reserve, tx, [ANVIL_KEYS[1]])).success).toBe(true);
    const policy = (await reservePolicy({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 }))!;
    expect(policy).toMatchObject({ armed: true, asDesigned: true, moduleEnabled: true, executorIsMember: true, dailyLimitUsd: 1000, periodHours: 24, triggerHf: 1.15, approved: true, issues: [] });
    expect(policy.roles.toLowerCase()).toBe(r.roles.toLowerCase());
    const status = (await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 }))!;
    expect(status).toMatchObject({ kind: "armed", label: "On", balanceUsd: 5000, limitUsd: 1000, usedUsd: 0, leftUsd: 1000, resetLabel: null });
    expect(status.banner).toBe("On: the agent can act on its own within these limits, without your signature.");
  });
  it("the policy shown is what the chain has: a wider scope signed later turns the Reserve Off and says why", async () => {
    const ctx = await ctxFor();
    const r = await linkReserve(ctx, input());
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect((await execSafeTx(fork, reserve, row!.tx as SafeTx, [ANVIL_KEYS[1]])).success).toBe(true);
    // The owners also let the role call anything on USDC.
    const wide = encodeFunctionData({ abi: [{ type: "function", name: "allowTarget", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }, { type: "uint8" }], outputs: [] }], functionName: "allowTarget", args: [ROLE_KEY, USDC, 0] });
    const nonce = String(await client.readContract({ address: reserve, abi: [{ type: "function", name: "nonce", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }], functionName: "nonce" }));
    const tx: SafeTx = { to: r.roles, value: "0", data: wide, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce };
    expect((await execSafeTx(fork, reserve, tx, [ANVIL_KEYS[1]])).success).toBe(true);
    const policy = (await reservePolicy({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 }))!;
    expect(policy.asDesigned).toBe(false);
    expect(policy.armed).toBe(false);
    expect(policy.issues.join(" ")).toMatch(/can also call/);
    expect((await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 }))!.label).toBe("Off");
  });
});

describe("BP-40: status from the on-chain allowance", () => {
  async function linked() {
    const ctx = await ctxFor();
    const r = await linkReserve(ctx, input());
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    await execSafeTx(fork, reserve, row!.tx as SafeTx, [ANVIL_KEYS[1]]);
    return r;
  }
  const status = async () => (await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 }))!;
  const repay = async (roles: Address, usd: string) => (await sendRoleCall(client, executor, buildRoleRepay({ chainId: 8453, roles, mainSafe: main, amount: parseUnits(usd, 6) }))).status;

  it("shows use today, Limit reached, and Resets in N h from the chain, then refills after the period", async () => {
    const r = await linked();
    expect(await repay(r.roles, "600")).toBe("success");
    let s = await status();
    expect(s).toMatchObject({ label: "On", usedUsd: 600, leftUsd: 400, limitUsd: 1000, balanceUsd: 4400 });
    expect(s.resetLabel).toMatch(/^Resets in (2[0-4]|1\d|\d) h$/);
    expect(await repay(r.roles, "400")).toBe("success");
    s = await status();
    expect(s).toMatchObject({ kind: "limitReached", label: "Limit reached", tone: "warning", leftUsd: 0 });
    expect(s.banner).toMatch(/^Limit reached: today's \$1,000 is used\. Resets in \d+ h\. The agent only suggests until then\.$/);
    await days(1.1);
    s = await status(); // lazy refill: the stored balance is 0, the read-out computes the refill
    expect(s).toMatchObject({ label: "On", usedUsd: 0, leftUsd: 1000, resetLabel: null });
  });
  it("is Off once the owners remove the executor from the role", async () => {
    const r = await linked();
    const off = encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [executor.address, [ROLE_KEY], [false]] });
    const nonce = String(await client.readContract({ address: reserve, abi: [{ type: "function", name: "nonce", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }], functionName: "nonce" }));
    const tx: SafeTx = { to: r.roles, value: "0", data: off, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce };
    await execSafeTx(fork, reserve, tx, [ANVIL_KEYS[1]]);
    const s = await status();
    expect(s).toMatchObject({ kind: "paused", label: "Off", armed: false });
    expect(s.banner).toBe("Off: the agent only suggests. Nothing moves without your signature.");
  });
  it("caches briefly: a second read inside the lifetime does not read chain again", async () => {
    await linked();
    const a = await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 60_000 });
    await setUsdc(reserve, 1n);
    const b = await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 60_000 });
    expect(b).toBe(a);
    clearReserveCache();
    expect((await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 60_000 }))!.balanceUsd).toBeLessThan(1);
  });
  it("no Reserve linked: null", async () => {
    await ctxFor();
    expect(await reserveStatus({ address: main, chainId: 8453 }, { db: w.db, client, ttlMs: 0 })).toBeNull();
  });
});

void buildReserveSetup; void erc20Abi;
