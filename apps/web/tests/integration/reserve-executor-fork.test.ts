// BP-41, BP-42 and monitoring test M6 on a Base fork with the real Aave pool and Roles v2: the monitor tick finds a
// loan below the trigger and the executor repays through the role in the same tick; chat card, email and Activity
// row follow; the allowance on-chain falls by the amount; over the limit the rest is drafted for the main Safe;
// a repay blocked by revoked permission is never reported as done.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getAddress, parseAbi, parseEther, parseUnits, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { setUsdc, stubReturning } from "../helpers/oracle";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { EXECUTOR_KEY, saveLink, deployReserve, executeRevoke, executorAddress, safeTx, revokeCall } from "../helpers/reserve-setup";
import { createAccess } from "@/server/auth/access";
import { erc20Abi, oracleAbi, poolAbi, wethAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { createViemReader } from "@/server/chain/reader";
import { safeContext } from "@/server/request";
import { reserveNowOption, useReserveNow } from "@/server/reserve/executor";
import { formatExactRawAmount } from "@/server/reserve/executor/use-now";
import { pendingChanges, permissionState, requestPolicyChange, turnReserveOff } from "@/server/reserve/policy-change";
import { loadReserveLink } from "@/server/reserve/executor/store";
import { activity, fixDrafts, messages, reserveRuns, users } from "@/server/db/schema";
import { DevEmailProvider } from "@/server/email/provider";
import { runMonitorTick } from "@/server/monitor/tick";
import { chainTestRunDeps } from "@/server/proposals/test-run";
import { allowanceNow } from "@/server/reserve";
import { createViemReserveChain } from "@/server/reserve/executor/chain";
import { setReserveRuntimeForTests } from "@/server/reserve/executor/runtime";
import { DevExecutorSigner } from "@/server/reserve";
import type { ExecLink } from "@/server/reserve/types";
import { delegateTypedData } from "@/server/safe/hash";
import { setServicesForTests, type Services } from "@/server/services";
import type { Address, Hex } from "@/shared/types";

const aave = AAVE[8453]!;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;
const owners = [0, 1].map((i) => privateKeyToAccount(ANVIL_KEYS[i]!).address) as Address[];
const oracleSource = parseAbi(["function getSourceOfAsset(address) view returns (address)"]);
const chain = createViemReserveChain();

let fork: Fork;
let main: Address;
let snap: Hex;
let w: TestWorld;
let services: Services;
let safeId: number;
let salt = 1100;
let hf0 = 0;
const operatorAlert = vi.fn();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function asMain(req: any) {
  const hash = await fork.walletClient.writeContract({ account: main, chain: fork.chain, gas: 2_000_000n, ...req });
  const r = await fork.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${req.functionName}`);
}
const hfNow = async () => Number((await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [main] }))[5]) / 1e18;
async function setHealth(target: number) {
  const price = await fork.publicClient.readContract({ address: aave.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [WETH] });
  const source = await fork.publicClient.readContract({ address: aave.oracle, abi: oracleSource, functionName: "getSourceOfAsset", args: [WETH] });
  await stubReturning(fork, source, [(price * BigInt(Math.round((target / (await hfNow())) * 1e6))) / 1_000_000n]);
}

/** A fresh Reserve (limit and balance in USDC) linked to the tracked main Safe. */
async function link(limit: number, balance = 20_000, ownerKeys?: Hex[]): Promise<ExecLink> {
  const l = { ...(await deployReserve(fork, { mainSafe: main, dailyLimitUsdc: limit, balanceUsdc: balance, saltNonce: String(salt++), ownerKeys })), safeId };
  await saveLink(w.db, l);
  return l;
}
const left = async (l: ExecLink) => { const a = await chain.read(l); return allowanceNow(a.allowance, a.nowSec).left; };

let email: DevEmailProvider;
let t = 0;
const tick = () => runMonitorTick({ db: w.db, reader: createViemReader(), now: new Date(Date.UTC(2026, 0, 1) + ++t * 60_000), log: () => {}, email });

beforeAll(async () => {
  fork = await startBaseFork();
  setPublicClientForTests(8453, fork.publicClient as PublicClient);
  main = getAddress((await deployTestSafe({ fork, owners, threshold: 2, saltNonce: String(salt++) })).address) as Address;
  await fork.testClient.setBalance({ address: main, value: parseEther("20") });
  await fork.testClient.impersonateAccount({ address: main });
  await asMain({ address: WETH, abi: wethAbi, functionName: "deposit", value: parseEther("5") });
  await asMain({ address: WETH, abi: erc20Abi, functionName: "approve", args: [aave.pool, parseEther("5")] });
  await asMain({ address: aave.pool, abi: poolAbi, functionName: "supply", args: [WETH, parseEther("5"), main, 0] });
  const data = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [main] });
  await asMain({ address: aave.pool, abi: poolAbi, functionName: "borrow", args: [USDC, parseUnits(String(Math.floor((Number(data[2]) / 1e8) * 0.55)), 6), 2n, 0, main] });
  await setUsdc(fork, main, 0n);
  await fork.testClient.setBalance({ address: executorAddress, value: parseEther("10") });
  hf0 = await hfNow();
}, 300_000);
afterAll(async () => { setPublicClientForTests(8453, undefined); await fork?.stop(); });

beforeEach(async () => {
  snap = (await fork.testClient.snapshot()) as unknown as Hex;
  w = await createTestWorld();
  const reader = createViemReader();
  services = { ...w.services, mock: false, reader, access: createAccess({ readOwners: reader.readSafeOwners }), testRunDeps: chainTestRunDeps };
  setServicesForTests(services);
  safeId = await w.trackSafe(main, { agentAdded: true });
  const fake = w.services.fakes.get(8453)!;
  fake.setOwners(main, owners, 2);
  const delegation = await privateKeyToAccount(ANVIL_KEYS[1]!).signTypedData(delegateTypedData(8453, services.signer.address));
  await fake.addDelegate({ safe: main, delegate: services.signer.address, delegator: owners[1]!, label: "Lender agent", signature: delegation });
  await w.db.insert(users).values({ address: owners[0]!.toLowerCase(), email: "owner@example.com" });
  email = new DevEmailProvider();
  operatorAlert.mockReset();
  setReserveRuntimeForTests({ chain, signer: new DevExecutorSigner(EXECUTOR_KEY), operatorAlert });
});
afterEach(async () => {
  setReserveRuntimeForTests(undefined);
  w.reset();
  await fork.testClient.revert({ id: snap });
});

const activityRows = () => w.db.select().from(activity).where(eq(activity.safeId, safeId));
const threadParts = async () => (await w.db.select().from(messages).where(eq(messages.safeId, safeId))).flatMap((m) => (m.message as { parts: { type: string; data?: Record<string, unknown>; text?: string }[] }).parts);

describe("BP-41 automatic repay below the trigger (M6)", () => {
  it("health above the trigger: nothing happens", async () => {
    expect(hf0).toBeGreaterThan(1.3);
    const l = await link(5000);
    await tick();
    expect(await w.db.select().from(reserveRuns)).toHaveLength(0);
    expect(await left(l)).toBe(5_000_000_000n);
  });

  it("below the trigger: repaid in the same tick through the role; card, email, Activity row; the allowance fell by the amount", async () => {
    const l = await link(5000);
    await setHealth(1.2);
    const before = await hfNow();
    expect(before).toBeLessThan(1.3);
    await tick();
    const [run] = await w.db.select().from(reserveRuns);
    expect(run).toMatchObject({ status: "done", origin: "auto" });
    expect(run.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The chain's own figures: health rose to the target, the allowance fell by the amount requested.
    const after = await hfNow();
    expect(after).toBeGreaterThan(1.55);
    expect(run.hfAfter).toBeCloseTo(after, 3);
    expect(5_000_000_000n - (await left(l))).toBe(BigInt(run.requestedRaw));
    expect(BigInt(run.requestedRaw)).toBeGreaterThan(500_000_000n);
    // Chat card with what / why / before / after / what is left.
    const card = (await threadParts()).find((p) => p.type === "data-reserve")!.data!;
    expect(card).toMatchObject({ runId: run.id });
    expect(String(card.what)).toMatch(/^Repaid [\d,.]+ USDC from your Reserve Safe/);
    expect(String(card.why)).toMatch(/below your reserve trigger of 1\.30/);
    expect(card.hfBefore).toBeCloseTo(before, 3);
    expect(card.hfAfter).toBeCloseTo(after, 3);
    expect(String(card.left)).toMatch(/^The Reserve Safe holds [\d,.]+ USDC\. Up to [\d,.]+ USDC more today\.$/);
    // Email and Activity.
    expect(email.sent.filter((m) => m.subject === "Your reserve repaid part of your loan").map((m) => m.to)).toEqual(["owner@example.com"]);
    const row = (await activityRows()).find((a) => a.actor === "Agent (reserve)")!;
    expect(row).toMatchObject({ kind: "reserve" });
    expect(row.text).toMatch(/^Used \$[\d,.]+ from Reserve Safe on your Aave v3 loan\. Done without your signature\.$/);
    expect(row.detail).toMatch(/health 1\.2\d → 1\.[56]\d/);
    // The next minute: above the trigger, no second repay.
    await tick();
    expect(await w.db.select().from(reserveRuns)).toHaveLength(1);
  }, 120_000);

  it("revoked membership blocks broadcast and alerts the owners and operator", async () => {
    const l = await link(5000);
    await executeRevoke(fork, l); // The owners revoked permission on-chain while the app still has the reserve enabled.
    await setHealth(1.2);
    const nonceBefore = await fork.publicClient.getTransactionCount({ address: executorAddress, blockTag: "pending" });
    await tick();
    const runs = await w.db.select().from(reserveRuns);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    const reason = "The reserve key is no longer a member of the on-chain role.";
    expect(run).toMatchObject({ status: "failed", error: reason, txHash: null, broadcastAt: null });
    expect(await fork.publicClient.getTransactionCount({ address: executorAddress, blockTag: "pending" })).toBe(nonceBefore);
    expect(await hfNow()).toBeLessThan(1.3);
    const parts = await threadParts();
    expect(parts.some((p) => p.type === "data-reserve")).toBe(false);
    const rows = await activityRows();
    expect(rows.some((a) => a.actor === "Agent (reserve)" && a.kind === "reserve")).toBe(false);
    expect(rows).toContainEqual(expect.objectContaining({ kind: "status", detail: reason, text: expect.stringContaining("could not repay") }));
    expect(parts.some((p) => p.type === "data-alert")).toBe(true); // the normal alert
    expect(email.sent.some((m) => /close to liquidation|At risk|risk/i.test(m.subject + m.text))).toBe(true);
    expect(email.sent.some((m) => m.subject === "Your reserve repaid part of your loan")).toBe(false);
    expect(operatorAlert).toHaveBeenCalledTimes(1);
    expect(operatorAlert).toHaveBeenCalledWith(
      `reserve repay failed for ${run.loanId}: ${reason}`,
      { runId: run.id, txHash: null },
    );
  }, 120_000);
});

describe("BP-42 partial use: the rest is drafted for the main Safe", () => {
  it("over the daily limit: the reserve uses what it may, the rest is drafted, and a second repay reverts on-chain", async () => {
    const l = await link(400);
    await setUsdc(fork, main, parseUnits("5000", 6)); // the main Safe can fund the drafted repay
    await setHealth(1.2);
    await tick();
    const [run] = await w.db.select().from(reserveRuns);
    expect(run).toMatchObject({ status: "done" });
    expect(BigInt(run.requestedRaw)).toBe(400_000_000n);
    expect(await left(l)).toBe(0n);
    expect(await hfNow()).toBeLessThan(1.6); // the reserve alone did not reach the target
    const drafts = await w.db.select().from(fixDrafts).where(and(eq(fixDrafts.safeId, safeId), eq(fixDrafts.state, "draft")));
    expect(drafts).toHaveLength(1);
    expect(run.restDraftId).toBe(drafts[0]!.id);
    const card = (await threadParts()).find((p) => p.type === "data-reserve")!.data!;
    expect(String(card.note)).toMatch(/^The daily limit is reached\. I drafted the rest below \(health 1\.\d\d after you sign\)\.$/);
    expect(card.draftId).toBe(drafts[0]!.id);
    // A second call over the limit reverts on-chain; the next ticks make none and draft nothing new.
    expect(await chain.repay(l, 1_000_000n, new DevExecutorSigner(EXECUTOR_KEY))).toMatchObject({ ok: false, name: "ConditionViolation", detail: "AllowanceExceeded" });
    await tick();
    expect(await w.db.select().from(reserveRuns)).toHaveLength(1);
    expect(await w.db.select().from(fixDrafts).where(eq(fixDrafts.safeId, safeId))).toHaveLength(1);
  }, 180_000);
});

const ctxOf = async (who: Address = owners[0]!) => safeContext(w.req("/", { cookie: (await w.signIn(who)).cookie }), main, services);
const loanId = () => `8453:${main.toLowerCase()}:aave-v3`;
const bothKeys = ANVIL_KEYS.slice(0, 2) as unknown as Hex[];
const signer = () => new DevExecutorSigner(EXECUTOR_KEY);

describe("BP-42 Use reserve now", () => {
  it("above the trigger: the dialog names the amount, confirming runs it under the same limit", async () => {
    const l = await link(5000);
    await setHealth(1.45); // above the 1.30 trigger, below the 1.60 target
    const ctx = await ctxOf();
    const o = await reserveNowOption(ctx, loanId());
    expect(o).toMatchObject({ enabled: true, label: "Runs now, without a signature" });
    expect(o.confirm).toMatch(/^Use up to \$[\d,]+(\.\d{1,6})? from reserve\?$/);
    expect(o.binding).not.toBeNull();
    expect(o.confirm).toBe(`Use up to $${formatExactRawAmount(BigInt(o.binding!.maxAmountRaw), 6)} from reserve?`);
    await expect(useReserveNow(ctx, loanId(), { confirm: false, binding: o.binding })).rejects.toMatchObject({ status: 400 });
    const before = await hfNow();
    const r = await useReserveNow(ctx, loanId(), { confirm: true, binding: o.binding });
    expect(r.status).toBe("done");
    expect(await hfNow()).toBeGreaterThan(before);
    const [run] = await w.db.select().from(reserveRuns);
    expect(run).toMatchObject({ origin: "now", status: "done" });
    expect(5_000_000_000n - (await left(l))).toBe(BigInt(run.requestedRaw));
    expect((await activityRows()).some((a) => a.actor === "Agent (reserve)" && a.kind === "reserve")).toBe(true);
  }, 120_000);

  it("disabled with the reason: off, at its limit, not needed; and only an owner of both Safes may use it", async () => {
    const l = await link(300, 20_000, [ANVIL_KEYS[0], ANVIL_KEYS[4]] as unknown as Hex[]);
    await setHealth(1.45);
    // An owner of the main Safe who does not own the Reserve Safe: refused.
    await expect(reserveNowOption(await ctxOf(owners[1]!), loanId())).rejects.toMatchObject({ status: 403 });
    // Limit used: the chain's allowance is 0.
    expect((await chain.repay(l, 300_000_000n, signer())).ok).toBe(true);
    await setHealth(1.45);
    const used = await reserveNowOption(await ctxOf(), loanId());
    expect(used).toMatchObject({ enabled: false, block: "capUsed" });
    expect(used.label).toMatch(/^Today's limit is used/);
    expect(used.message).toMatch(/^Today's reserve limit is used/);
    await expect(useReserveNow(await ctxOf(), loanId(), { confirm: true, binding: used.binding })).rejects.toMatchObject({ status: 409 });
    // Off.
    expect((await chain.read(l)).executorIsMember).toBe(true);
    await w.db.update((await import("@/server/db/schema")).reserveLinks).set({ state: "off" });
    expect(await reserveNowOption(await ctxOf(), loanId())).toMatchObject({
      enabled: false, block: "paused", label: "Reserve off",
      message: "The agent has stopped using the reserve. The Safe permission stays active until the owners execute its removal transaction.",
    });
    const revokeTx = await safeTx(fork, l.reserveSafe, revokeCall(l));
    const revoked = await execSafeTx(fork, l.reserveSafe, revokeTx, [ANVIL_KEYS[0], ANVIL_KEYS[4]] as unknown as Hex[]);
    expect(revoked.success).toBe(true);
    expect((await chain.read(l)).executorIsMember).toBe(false);
    expect(await reserveNowOption(await ctxOf(), loanId())).toMatchObject({
      enabled: false, block: "paused", label: "Reserve off",
      message: "Reserve protection is off. You can review the limits and approve it again in Reserve.",
    });
  }, 120_000);
});

describe("BP-43 turn off and change the policy", () => {
  it("off: the executor stops at once; the page says the permission is still active; after the owners sign the call reverts on-chain", async () => {
    const l = await link(5000);
    const ctx = await ctxOf();
    const off = await turnReserveOff(ctx, 8453);
    expect(off.permission).toMatchObject({ agent: "stopped", chain: "active" });
    expect(off.sentence).toBe("The agent has stopped using the reserve. Sign in Safe to remove the permission.");
    expect((await loadReserveLink(w.db, safeId, 8453))!.active).toBe(false);
    // The chain still lets the executor act, but the app does not: a tick below the trigger makes no call.
    expect((await chain.read(l)).executorIsMember).toBe(true);
    await setHealth(1.2);
    await tick();
    expect(await w.db.select().from(reserveRuns)).toHaveLength(0);
    expect(await left(l)).toBe(5_000_000_000n);
    expect((await activityRows()).some((a) => a.text === "Turned the reserve off. The agent stopped using it.")).toBe(true);
    // The owners sign the transaction we built: the role is removed and the executor's call reverts.
    expect((await execSafeTx(fork, l.reserveSafe, off.tx, bothKeys)).success).toBe(true);
    expect(await chain.repay(l, 1_000_000n, signer())).toMatchObject({ ok: false, name: "NoMembership" });
    expect(await permissionState(ctx, null, 8453, safeId)).toMatchObject({ agent: "stopped", chain: "removed" });
    await tick();
    expect((await activityRows()).some((a) => a.text === "Turned reserve off. Signed in Reserve Safe")).toBe(true);
    expect(await pendingChanges(ctx, 8453)).toHaveLength(0);
  }, 180_000);

  it("change the limit: validated, nothing changes until the owners sign, then the chain shows it and Activity logs it", async () => {
    const l = await link(1000, 8000);
    const ctx = await ctxOf();
    await expect(requestPolicyChange(ctx, 8453, { dailyLimitUsd: "9000" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^The Reserve Safe holds \$8,000/) });
    await expect(requestPolicyChange(ctx, 8453, { dailyLimitUsd: "0.5" })).rejects.toMatchObject({ status: 400 });
    await expect(requestPolicyChange(ctx, 8453, { trigger: "2.5" })).rejects.toMatchObject({ status: 400, message: "Use a number from 1.02 to 2.00" });
    await expect(requestPolicyChange(ctx, 8453, { trigger: "1.01" })).rejects.toMatchObject({ status: 400 });
    const change = await requestPolicyChange(ctx, 8453, { dailyLimitUsd: "2,500", trigger: "1.40" });
    expect(change.summary).toMatch(/limit to 2500 USDC per day and trigger to health 1\.40/);
    await tick();
    expect((await chain.read(l)).allowance.maxRefill).toBe(1_000_000_000n);
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.3);
    expect((await execSafeTx(fork, l.reserveSafe, change.tx, bothKeys)).success).toBe(true);
    await tick();
    const state = (await chain.read(l)).allowance;
    expect([state.maxRefill, state.refill]).toEqual([2_500_000_000n, 2_500_000_000n]);
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.4);
    expect((await activityRows()).some((a) => a.text === "Changed reserve limit to $2,500 and trigger to health 1.40. Signed in Reserve Safe")).toBe(true);
    // Logged once.
    await tick();
    expect((await activityRows()).filter((a) => a.text.startsWith("Changed reserve"))).toHaveLength(1);
  }, 180_000);

  it("a policy change needs an owner of the Reserve Safe", async () => {
    await link(1000, 20_000, [ANVIL_KEYS[0], ANVIL_KEYS[4]] as unknown as Hex[]);
    await expect(requestPolicyChange(await ctxOf(owners[1]!), 8453, { dailyLimitUsd: "2500" })).rejects.toMatchObject({ status: 403 });
  }, 120_000);

  it("change only the trigger: a Reserve Safe signature is still required; applied once executed", async () => {
    const l = await link(1000);
    const ctx = await ctxOf();
    const change = await requestPolicyChange(ctx, 8453, { trigger: "1.50" });
    await tick();
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.3);
    expect((await execSafeTx(fork, l.reserveSafe, change.tx, bothKeys)).success).toBe(true);
    await tick();
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.5);
    expect((await activityRows()).some((a) => a.text === "Changed reserve trigger to health 1.50. Signed in Reserve Safe")).toBe(true);
  }, 180_000);
});
