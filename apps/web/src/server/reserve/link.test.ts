import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { eq } from "drizzle-orm";
import { MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "@/shared/types";
import { proposals, reserveLinks, reservePolicyChanges } from "@/server/db/schema";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { linkReserve } from "./link";
import { turnReserveOff } from "./policy-change";
import { reconcilePolicyChanges } from "./policy-change/reconcile";
import { loadReserveLink } from "./executor/store";
import { getReserveRuntime, resetMockReserveChain } from "./executor/runtime";
import type { FixtureReserveChain } from "./executor/fixture-chain";
import { reserveNowOption, useReserveNow } from "./executor/use-now";
import { RESERVE_ASSET } from "./constants";
import { multiSendAbi } from "@/server/safe/multisend";
import { rolesAbi } from "./roles-abi";
import { ALLOWANCE_KEY } from "./constants";
import type { LoanPosition } from "@/shared/types";

const MAIN = "0x1111111111111111111111111111111111111111" as Address;
const RESERVE = "0x2222222222222222222222222222222222222222" as Address;
let w: TestWorld;

beforeEach(() => { process.env.MOCK = "1"; });
afterEach(() => { w?.reset(); resetMockReserveChain(); delete process.env.MOCK; });

async function context() {
  w = await createTestWorld();
  await w.trackSafe(MAIN, { name: "Treasury Safe", agentAdded: true });
  const fake = w.services.fakes.get(8453)!;
  for (const address of [MAIN, RESERVE]) {
    fake.setOwners(address, [MOCK_OWNER], 1);
    w.services.fixture.setOwners(8453, address, [MOCK_OWNER], 1);
    const signature: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
    await fake.addDelegate({ safe: address, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature });
  }
  w.services.fixture.setBalances(8453, RESERVE, { USDC: 2500 });
  const { cookie } = await w.signIn(MOCK_OWNER);
  return safeContext(w.req("/", { cookie }), MAIN, w.services);
}

describe("reserve relinking", () => {
  it("preserves the deployed Roles event start when a rejected restore is retried", async () => {
    const ctx = await context();
    const input = { chainId: 8453 as const, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 };
    const first = await linkReserve(ctx, input);
    const chain = getReserveRuntime(ctx.services, () => {}).chain as FixtureReserveChain;
    let linked = (await loadReserveLink(w.db, ctx.safe.id, 8453))!;
    const [firstLink] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    chain.setup(linked, { dailyLimitRaw: 1_000_000_000n, members: [linked.executor] });
    await w.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, first.proposalId));
    await w.db.update(reserveLinks).set({ state: "linked", fromBlock: 42n }).where(eq(reserveLinks.id, firstLink!.id));
    linked = (await loadReserveLink(w.db, ctx.safe.id, 8453))!;

    await turnReserveOff(ctx, 8453);
    chain.revoke(linked, linked.executor);
    const firstRestore = await linkReserve(ctx, input);
    await w.db.update(proposals).set({ stage: "rejected" }).where(eq(proposals.id, firstRestore.proposalId));

    await linkReserve(ctx, input);
    const [restored] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    expect(restored!.fromBlock).toBe(42n);
    expect(restored!.attempt).toBe(2);
  });

  it("restores the limit exactly to six USDC decimals", async () => {
    const ctx = await context();
    const original = await linkReserve(ctx, { chainId: 8453, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 });
    const chain = getReserveRuntime(ctx.services, () => {}).chain as FixtureReserveChain;
    const linked = (await loadReserveLink(w.db, ctx.safe.id, 8453))!;
    const [firstLink] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    chain.setup(linked, { dailyLimitRaw: 1_000_000_000n, members: [linked.executor] });
    await w.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, original.proposalId));
    await w.db.update(reserveLinks).set({ state: "linked" }).where(eq(reserveLinks.id, firstLink!.id));
    await turnReserveOff(ctx, 8453);
    chain.revoke(linked, linked.executor);
    const restored = await linkReserve(ctx, { chainId: 8453, reserveSafe: RESERVE, dailyLimitUsd: 1000.006, triggerHf: 1.2 });
    const [proposal] = await w.db.select().from(proposals).where(eq(proposals.id, restored.proposalId)).limit(1);
    const outer = decodeFunctionData({ abi: multiSendAbi, data: (proposal!.tx as { data: `0x${string}` }).data });
    const packed = outer.args[0].slice(2);
    let offset = 0;
    const calls: { data: `0x${string}` }[] = [];
    while (offset < packed.length) {
      offset += 2; // operation
      offset += 40; // to
      offset += 64; // value
      const length = Number(BigInt(`0x${packed.slice(offset, offset + 64)}`));
      offset += 64;
      calls.push({ data: `0x${packed.slice(offset, offset + length * 2)}` });
      offset += length * 2;
    }
    const decoded = calls.flatMap((call) => {
      try { return [decodeFunctionData({ abi: rolesAbi, data: call.data })]; }
      catch { return []; }
    });
    const allowance = decoded.find((call) => call.functionName === "setAllowance");
    expect(allowance?.args?.slice(0, 5)).toEqual([ALLOWANCE_KEY, 1_000_006_000n, 1_000_006_000n, 1_000_006_000n, 86_400n]);
  });

  it("does not let a delayed old revocation turn a new restore off", async () => {
    const ctx = await context();
    const input = { chainId: 8453 as const, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 };
    const first = await linkReserve(ctx, input);
    const chain = getReserveRuntime(ctx.services, () => {}).chain as FixtureReserveChain;
    let linked = (await loadReserveLink(w.db, ctx.safe.id, 8453))!;
    const [firstLink] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    chain.setup(linked, { dailyLimitRaw: 1_000_000_000n, members: [linked.executor] });
    await w.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, first.proposalId));
    await w.db.update(reserveLinks).set({ state: "linked" }).where(eq(reserveLinks.id, firstLink!.id));
    linked = (await loadReserveLink(w.db, ctx.safe.id, 8453))!;
    await turnReserveOff(ctx, 8453);
    chain.revoke(linked, linked.executor);

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let reads = 0;
    const realRead = chain.read.bind(chain);
    const delayedRead = vi.spyOn(chain, "read").mockImplementation(async (candidate) => {
      reads++;
      if (reads === 1) { markStarted(); await readGate; }
      return realRead(candidate);
    });
    const slowReconcile = reconcilePolicyChanges({ db: w.db, services: ctx.services, now: new Date(), log: () => {} }, ctx.safe.id, 8453);
    try {
      await started;
      await reconcilePolicyChanges({ db: w.db, services: ctx.services, now: new Date(), log: () => {} }, ctx.safe.id, 8453);
      const restore = await linkReserve(ctx, input);
      const [newLink] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
      expect(newLink).toMatchObject({ state: "pending", attempt: 1, setupProposalId: restore.proposalId });
      releaseRead();
      await slowReconcile;
      const [after] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
      expect(after).toMatchObject({ state: "pending", attempt: 1, setupProposalId: restore.proposalId });
      const [revocation] = await w.db.select().from(reservePolicyChanges).where(eq(reservePolicyChanges.kind, "off")).limit(1);
      expect(revocation!.status).toBe("applied");
    } finally {
      releaseRead();
      delayedRead.mockRestore();
      await slowReconcile;
    }
  });

  it("rejects direct relinking while revocation is pending or the old executor role remains", async () => {
    const ctx = await context();
    const input = { chainId: 8453 as const, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 };
    await linkReserve(ctx, input);
    const [link] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    await w.db.update(reserveLinks).set({ state: "off" }).where(eq(reserveLinks.id, link!.id));
    await w.db.insert(reservePolicyChanges).values({ id: "pending-off", safeId: ctx.safe.id, chainId: 8453, kind: "off", tx: {}, safeTxHash: "0x1234", status: "pending" });
    await expect(linkReserve(ctx, input)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/revok|permission/i) });

    await w.db.update(reservePolicyChanges).set({ status: "failed" }).where(eq(reservePolicyChanges.id, "pending-off"));
    await expect(linkReserve(ctx, input)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/revok|permission/i) });
  });

  it("restores the retained Roles module after confirmed revoke and executes with the new fractional cap", async () => {
    const ctx = await context();
    const input = { chainId: 8453 as const, reserveSafe: RESERVE, dailyLimitUsd: 1000.25, triggerHf: 1.234 };
    const first = await linkReserve(ctx, input);
    const chain = getReserveRuntime(ctx.services, () => {}).chain as FixtureReserveChain;
    expect(first.executor).toBe(getReserveRuntime(ctx.services, () => {}).signer.address);
    let linked = (await loadReserveLink(w.db, ctx.safe.id, 8453))!;
    const [firstLink] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    expect(chain.enabledModules()).toHaveLength(0);
    chain.setup(linked, { dailyLimitRaw: 1_000_000_000n, members: [linked.executor] });
    const [firstProposal] = await w.db.select().from(proposals).where(eq(proposals.id, firstLink!.setupProposalId!)).limit(1);
    await w.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, firstProposal!.id));
    await w.db.update(reserveLinks).set({ state: "linked" }).where(eq(reserveLinks.mainSafeId, ctx.safe.id));
    expect(chain.enabledModules()).toEqual([linked.roles.toLowerCase()]);

    await turnReserveOff(ctx, 8453);
    chain.revoke(linked, linked.executor);

    // Simulate a process losing the transaction response after PostgreSQL commits. The setup
    // proposal and the pending link must agree, and retrying must reuse that same proposal.
    const originalTransaction = w.db.transaction.bind(w.db);
    let loseCommitResponse = true;
    const faultDb = Object.create(w.db) as typeof w.db;
    faultDb.transaction = async (callback, config) => {
      const result = await originalTransaction(callback, config);
      const committed = Array.isArray(result) ? result[0] : result;
      if (loseCommitResponse && committed && typeof committed === "object" && "safeTxHash" in committed) {
        loseCommitResponse = false;
        throw new Error("Injected lost transaction response");
      }
      return result;
    };
    await expect(linkReserve({ ...ctx, db: faultDb }, input)).rejects.toThrow("Injected lost transaction response");
    const [committedLink] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    expect(committedLink).toMatchObject({ state: "pending", rolesAddress: linked.roles.toLowerCase() });
    const [committedSetup] = await w.db.select().from(proposals).where(eq(proposals.id, committedLink!.setupProposalId!)).limit(1);
    expect(committedSetup).toBeTruthy();

    const restored = await linkReserve(ctx, input);
    const [revocation] = await w.db.select().from(reservePolicyChanges).where(eq(reservePolicyChanges.safeId, ctx.safe.id)).limit(1);
    expect(revocation!.status).toBe("applied"); // link API reconciles from chain even with no live loan/monitor tick
    expect(restored.roles).toBe(linked.roles);
    linked = (await loadReserveLink(w.db, ctx.safe.id, 8453))!;
    const [restoredLink] = await w.db.select().from(reserveLinks).where(eq(reserveLinks.mainSafeId, ctx.safe.id)).limit(1);
    expect(chain.enabledModules()).toEqual([linked.roles.toLowerCase()]);
    const [restoreProposal] = await w.db.select().from(proposals).where(eq(proposals.id, restoredLink!.setupProposalId!)).limit(1);
    expect(restoreProposal!.id).toBe(committedSetup!.id);
    expect(restoreProposal!.title).toMatch(/restore/i);
    expect(restoreProposal!.spec).toMatchObject({ roles: linked.roles, dailyLimitUsd: 1000.25, triggerHf: 1.234, attempt: 1 });
    chain.setup(linked, { dailyLimitRaw: 1_000_250_000n, members: [linked.executor] });
    await w.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, restoreProposal!.id));
    await w.db.update(reserveLinks).set({ state: "linked" }).where(eq(reserveLinks.mainSafeId, ctx.safe.id));

    const asset = RESERVE_ASSET[8453]!;
    const loanId = `8453:${MAIN}:aave-v3`;
    const position: LoanPosition = {
      chainId: 8453, safe: MAIN, lender: "aave-v3", id: loanId, healthFactor: 1.01, liquidationThreshold: 0.8, ltv: 0.7, mixed: false, blockNumber: 1n,
      collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 6320 }],
      debt: [{ asset: "USDC", token: asset.usdc, amount: 5000, usd: 5000 }],
    };
    w.services.fixture.setPosition(8453, MAIN, position);
    const option = await reserveNowOption(ctx, loanId);
    expect(option).toMatchObject({ enabled: true, binding: { maxAmountRaw: "1000250000", triggerHf: 1.234 } });
    await expect(useReserveNow(ctx, loanId, { confirm: true, binding: { ...option.binding!, policyRefillRaw: "999999999" } }))
      .rejects.toMatchObject({ status: 409 });
    expect((await w.services.fixture.readBalances(8453, RESERVE)).balances.find((balance) => balance.symbol === "USDC")?.raw).toBe(2_500_000_000n);
    await expect(useReserveNow(ctx, loanId, { confirm: false, binding: option.binding! })).rejects.toMatchObject({ status: 400 });
    const used = await useReserveNow(ctx, loanId, { confirm: true, binding: option.binding! });
    expect(used.status).toBe("done");
    expect(chain.state(linked)?.allowance.balance).toBe(0n);
    expect((await w.services.fixture.readBalances(8453, RESERVE)).balances.find((balance) => balance.symbol === "USDC")?.raw).toBe(1_499_750_000n);
    expect(chain.enabledModules()).toEqual([linked.roles.toLowerCase()]);
    w.services.fixture.setPosition(8453, MAIN, { ...position, debt: [...position.debt, { asset: "DAI", token: "0x0000000000000000000000000000000000000da1", amount: 1, usd: 1 }] });
    expect(await reserveNowOption(ctx, loanId)).toMatchObject({ enabled: false, message: expect.stringMatching(/one USDC debt/i) });
  });
});
