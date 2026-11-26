import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Address, LoanPosition } from "@/shared/types";
import { proposals, reserveLinks, reserveRuns, safeNetworks, safes } from "@/server/db/schema";
import type { ReserveRuntime } from "@/server/reserve/executor/runtime";
import { gateHandoff, submitPreparedIfAuthorized } from "@/server/reserve/executor/broadcast";
import type { PreparedRepay, ReserveChain } from "@/server/reserve/executor/chain";
import { linkFingerprint, releaseExpiredUnwatchedHandoff, stopReserve, withReserveLinkLock } from "@/server/reserve/executor/store";
import type { ExecLink } from "@/server/reserve/types";
import { deliver } from "@/server/proposals/send";
import { stopAgentProposals } from "@/server/agent-role";
import type { SafeService } from "@/server/safe/service-client";
import type { Services } from "@/server/services";
import { createPostgresLockWorld, waitForPostgresLockWait, type PostgresLockWorld } from "../helpers/postgres-lock-db";

const enabled = !!process.env.PG_LOCK_TEST_URL;
const MAIN_A = "0x00000000000000000000000000000000000000a1" as Address;
const RESERVE_A = "0x00000000000000000000000000000000000000b1" as Address;
const MAIN_B = "0x00000000000000000000000000000000000000a2" as Address;
const RESERVE_B = "0x00000000000000000000000000000000000000b2" as Address;
const MAIN_C = "0x00000000000000000000000000000000000000a3" as Address;
const RESERVE_C = "0x00000000000000000000000000000000000000b3" as Address;
const MAIN_D = "0x00000000000000000000000000000000000000a4" as Address;
const RESERVE_D = "0x00000000000000000000000000000000000000b4" as Address;
const ROLES = "0x00000000000000000000000000000000000000c1" as Address;
const EXECUTOR = "0x00000000000000000000000000000000000000d1" as Address;
const OWNER = "0x00000000000000000000000000000000000000e1" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const RAW = `0x${"ab".repeat(70)}` as `0x${string}`;
const HASH0 = `0x${"11".repeat(32)}` as `0x${string}`;
const HASH1 = `0x${"22".repeat(32)}` as `0x${string}`;
const PROPOSAL_HASH = `0x${"33".repeat(32)}` as `0x${string}`;
const PROPOSAL_HASH_LOCK = `0x${"55".repeat(32)}` as `0x${string}`;
const PROPOSAL_SIGNATURE = `0x${"44".repeat(65)}` as `0x${string}`;
const PROPOSAL_SAFE = "0x00000000000000000000000000000000000000f1" as Address;
const PROPOSAL_SAFE_LOCK = "0x00000000000000000000000000000000000000f4" as Address;
const AGENT = "0x00000000000000000000000000000000000000f2" as Address;
const DELEGATOR = "0x00000000000000000000000000000000000000f3" as Address;

const position = (main: Address): LoanPosition => ({
  chainId: 8453, safe: main, lender: "aave-v3", id: `8453:${main.toLowerCase()}:aave-v3`, healthFactor: 1.05,
  liquidationThreshold: 0.8, ltv: 0.7, mixed: false, blockNumber: 1n,
  collateral: [{ asset: "WETH", token: RESERVE_A, amount: 2, usd: 1_312.5 }],
  debt: [{ asset: "USDC", token: USDC, amount: 1_000, usd: 1_000 }],
});

let world: PostgresLockWorld;

async function seedLink(db: PostgresLockWorld["dbA"], mainAddress: Address, reserveAddress: Address) {
  const [main] = await db.insert(safes).values({ address: mainAddress.toLowerCase(), name: "Main test Safe" }).returning();
  const [reserve] = await db.insert(safes).values({ address: reserveAddress.toLowerCase(), name: "Reserve test Safe" }).returning();
  const [row] = await db.insert(reserveLinks).values({
    mainSafeId: main.id, reserveSafeId: reserve.id, chainId: 8453,
    rolesAddress: ROLES.toLowerCase(), executorAddress: EXECUTOR.toLowerCase(), saltNonce: "1",
    dailyLimit: "20000000000", triggerHf: 1.3, fromBlock: 1n, state: "linked",
  }).returning();
  const link: ExecLink = {
    safeId: main.id, chainId: 8453, mainSafe: mainAddress, reserveSafe: reserveAddress,
    roles: ROLES, executor: EXECUTOR, token: USDC, tokenSymbol: "USDC", tokenDecimals: 6,
    trigger: 1.3, attempt: 0, active: true, fromBlock: 1n,
  };
  return { safeId: main.id, link, linkRow: row };
}

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe.skipIf(!enabled)("reserve locks use independent PostgreSQL sessions", () => {
  beforeAll(async () => { world = await createPostgresLockWorld(); });
  afterAll(async () => { await world?.close(); });

  it("makes turn-off wait for an active submission under the production reserve_links row lock", async () => {
    const { safeId, link } = await seedLink(world.dbA, MAIN_A, RESERVE_A);
    const [run] = await world.dbA.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN_A).id, key: "manual:row-lock", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.05, origin: "auto", linkFingerprint: linkFingerprint(link),
      signedTx: RAW, txHash: HASH0, nonce: 0, executorAddress: EXECUTOR.toLowerCase(), broadcastAt: new Date(),
    }).returning();
    const tx: PreparedRepay = { raw: RAW, hash: HASH0, nonce: 0 };
    const submitEntered = deferred<void>();
    const releaseSubmit = deferred<void>();
    const chain = { submit: async () => { submitEntered.resolve(); await releaseSubmit.promise; } } as unknown as ReserveChain;
    const rt = {
      chain: {
        read: async () => ({ allowance: { refill: 20_000_000_000n, maxRefill: 20_000_000_000n, period: 86_400n, balance: 20_000_000_000n, timestamp: 1n }, nowSec: 1_000, balance: 20_000_000_000n, executorIsMember: true, policyAsDesigned: true }),
        submit: chain.submit,
      },
    } as unknown as Pick<ReserveRuntime, "chain">;
    const reader = { readAavePosition: async () => ({ position: position(MAIN_A) }), readSafeOwners: async () => [OWNER] } as never;
    const submitTask = submitPreparedIfAuthorized({ db: world.dbA, reader, now: new Date() }, rt, run!, tx);
    await submitEntered.promise;

    const stopTask = stopReserve(world.dbB, safeId, 8453).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      // This is an independent backend session waiting on the locked reserve_links row.
      expect(await waitForPostgresLockWait(world.observer, world.appB, "reserve_links")).toBe(true);
    } finally {
      releaseSubmit.resolve();
    }

    expect(await submitTask).toMatchObject({ kind: "submitted" });
    const stopped = await stopTask;
    expect("error" in stopped ? stopped.error : null).toMatchObject({ status: 409 });
    const [stored] = await world.dbB.select({ state: reserveLinks.state }).from(reserveLinks).where(eq(reserveLinks.mainSafeId, safeId));
    expect(stored?.state).toBe("linked");
    await world.dbA.delete(reserveRuns).where(eq(reserveRuns.id, run!.id));
  });

  it("keeps the reserved nonce when submission intent commits during unwatched handoff release", async () => {
    const main = "0x00000000000000000000000000000000000000a5";
    const { safeId, link } = await seedLink(world.dbA, main, "0x00000000000000000000000000000000000000b5");
    await world.dbA.insert(safeNetworks).values({ safeId, chainId: 8453, deployed: true, agentAdded: false });
    const now = new Date();
    const [run] = await world.dbA.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(main).id, key: "auto:unwatched-release-race", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.05, linkFingerprint: linkFingerprint(link),
      signedTx: RAW, txHash: HASH0, nonce: 0, executorAddress: EXECUTOR, leaseExpiresAt: now,
    }).returning();
    const intentWritten = deferred<void>();
    const commit = deferred<void>();
    const intent = withReserveLinkLock(world.dbA, safeId, 8453, async (tx) => {
      await tx.update(reserveRuns).set({ broadcastAt: now, leaseExpiresAt: null }).where(eq(reserveRuns.id, run.id));
      intentWritten.resolve();
      await commit.promise;
    });
    await intentWritten.promise;
    const release = releaseExpiredUnwatchedHandoff(world.dbB, safeId, 8453, run.id, now);
    try {
      expect(await waitForPostgresLockWait(world.observer, world.appB, "reserve_links")).toBe(true);
    } finally {
      commit.resolve();
      await Promise.all([intent, release]);
    }
    const [stored] = await world.dbB.select().from(reserveRuns).where(eq(reserveRuns.id, run.id));
    expect(stored).toMatchObject({
      status: "pending", broadcastAt: now, leaseExpiresAt: null, signedTx: RAW,
      txHash: HASH0, nonce: 0, executorAddress: EXECUTOR,
    });
    await world.dbA.delete(reserveRuns).where(eq(reserveRuns.id, run.id));
  });

  it("serializes nonce allocation for two reserves sharing an executor with pg_advisory_xact_lock", async () => {
    const a = await seedLink(world.dbA, MAIN_C, RESERVE_C);
    const b = await seedLink(world.dbB, MAIN_D, RESERVE_D);
    const now = new Date();
    const [runA] = await world.dbA.insert(reserveRuns).values({
      safeId: a.safeId, chainId: 8453, loanId: position(MAIN_C).id, key: "auto:nonce-a", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.05, origin: "auto", linkFingerprint: linkFingerprint(a.link), leaseExpiresAt: new Date(now.getTime() + 60_000),
    }).returning();
    const [runB] = await world.dbB.insert(reserveRuns).values({
      safeId: b.safeId, chainId: 8453, loanId: position(MAIN_D).id, key: "auto:nonce-b", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.05, origin: "auto", linkFingerprint: linkFingerprint(b.link), leaseExpiresAt: new Date(now.getTime() + 60_000),
    }).returning();

    const prepareAEntered = deferred<void>();
    const releasePrepareA = deferred<void>();
    const prepared: Array<{ safeId: number; nonce: number }> = [];
    const chain = {
      read: async () => ({ allowance: { refill: 20_000_000_000n, maxRefill: 20_000_000_000n, period: 86_400n, balance: 20_000_000_000n, timestamp: 1n }, nowSec: 1_000, balance: 20_000_000_000n, executorIsMember: true, policyAsDesigned: true }),
      nonce: async () => 0,
      prepare: async (link: ExecLink, _amount: bigint, nonce: number) => {
        prepared.push({ safeId: link.safeId, nonce });
        if (link.safeId === a.safeId) { prepareAEntered.resolve(); await releasePrepareA.promise; }
        const hash = nonce === 0 ? HASH0 : HASH1;
        return { ok: true as const, tx: { raw: `${RAW}${nonce.toString(16)}` as `0x${string}`, hash, nonce } };
      },
    } as unknown as ReserveChain;
    const reader = { readAavePosition: async (_chainId: number, address: string) => ({ position: position(address.toLowerCase() as Address) }) } as never;
    const rt = { chain, signer: {} } as Pick<ReserveRuntime, "chain" | "signer">;
    const taskA = gateHandoff({ db: world.dbA, reader, now }, rt, runA!, { target: 1.4 });
    const reachedPrepare = await Promise.race([
      prepareAEntered.promise.then(() => ({ kind: "prepared" as const })),
      taskA.then((verdict) => ({ kind: "verdict" as const, verdict }), (error: unknown) => ({ kind: "error" as const, error })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 5_000)),
    ]);
    expect(reachedPrepare.kind, JSON.stringify(reachedPrepare)).toBe("prepared");
    const taskB = gateHandoff({ db: world.dbB, reader, now }, rt, runB!, { target: 1.4 });

    try {
      // B has a different reserve_links row, so this wait can only be the shared executor advisory lock.
      expect(await waitForPostgresLockWait(world.observer, world.appB, "pg_advisory_xact_lock")).toBe(true);
      expect(prepared.map((p) => p.safeId)).toEqual([a.safeId]);
    } finally {
      releasePrepareA.resolve();
    }

    const [resultA, resultB] = await Promise.all([taskA, taskB]);
    expect(resultA.kind).toBe("handoff");
    expect(resultB).toMatchObject({ kind: "skipped", reason: "no-room" });
    expect(prepared.map((p) => p.nonce)).toEqual([0]);

    // The matching receipt can settle A before the pending nonce reported by another node advances.
    await world.dbA.update(reserveRuns).set({ status: "done", broadcastAt: now, leaseExpiresAt: null }).where(eq(reserveRuns.id, runA!.id));
    const { id: _id, ...retryClaim } = runB!;
    const [retry] = await world.dbB.insert(reserveRuns).values(retryClaim).returning();
    const result = await gateHandoff({ db: world.dbB, reader, now }, rt, retry!, { target: 1.4 });
    expect(result).toMatchObject({ kind: "handoff", tx: { nonce: 1 } });
    expect(prepared.map((p) => p.nonce)).toEqual([0, 1]);
  });



  it("does not let agent removal release a proposal whose Safe POST is in flight", async () => {
    const [safe] = await world.dbA.insert(safes).values({ address: PROPOSAL_SAFE.toLowerCase(), name: "Removal race Safe" }).returning();
    const [proposal] = await world.dbA.insert(proposals).values({
      id: "proposal-agent-removal-race", safeId: safe!.id, chainId: 8453,
      spec: { kind: "open" },
      tx: { to: PROPOSAL_SAFE, value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: 0 },
      nonce: 0n, safeTxHash: PROPOSAL_HASH, idempotencyKey: "proposal-agent-removal-race", title: "Synthetic proposal",
      steps: ["Synthetic proposal"], outcome: "Synthetic", stage: "sending",
    }).returning();

    const postEntered = deferred<void>();
    const releasePost = deferred<void>();
    let accepted = false;
    let agentActive = true;
    const live = { safe: PROPOSAL_SAFE, confirmations: [], isExecuted: false } as never;
    const service = {
      listDelegates: async () => agentActive ? [{ safe: PROPOSAL_SAFE, delegate: AGENT, delegator: DELEGATOR, label: "test" }] : [],
      getMultisigTransaction: async () => accepted ? live : null,
      proposeTransaction: async () => { postEntered.resolve(); await releasePost.promise; accepted = true; },
      deleteTransaction: async () => { throw new Error("delete was not confirmed"); },
    } as unknown as SafeService;
    const services = {
      safeService: () => service,
      reader: { readSafeNonce: async () => 0n },
      signer: {
        address: AGENT,
        signProposal: async () => ({ safeTxHash: PROPOSAL_HASH, signature: PROPOSAL_SIGNATURE }),
        signDeleteRequest: async () => PROPOSAL_SIGNATURE,
      },
    } as unknown as Services;

    const submit = deliver(world.dbA, services, proposal!, PROPOSAL_SAFE);
    await postEntered.promise;
    agentActive = false;
    let release!: () => void;
    const removeFinished = new Promise<void>((resolve) => { release = resolve; });
    const remove = stopAgentProposals(world.dbB, services, safe!.id).finally(release);
    try {
      const removedBeforePost = await Promise.race([
        removeFinished.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(removedBeforePost).toBe(true);
      const [during] = await world.dbB.select().from(proposals).where(eq(proposals.id, proposal!.id));
      expect(during?.deletedFromQueue).toBe(false);
      expect(during?.stage).toBe("sending");
    } finally {
      releasePost.resolve();
    }

    await Promise.all([submit, remove]);
    const [stored] = await world.dbB.select().from(proposals).where(eq(proposals.id, proposal!.id));
    expect(stored?.deletedFromQueue).toBe(false);
    expect(stored?.stage).toBe("stopped");
  });


  it("allows only one PostgreSQL session to submit a claimed proposal", async () => {
    const [safe] = await world.dbA.insert(safes).values({ address: PROPOSAL_SAFE_LOCK.toLowerCase(), name: "Proposal lock test Safe" }).returning();
    const [proposal] = await world.dbA.insert(proposals).values({
      id: "proposal-row-lock-test", safeId: safe!.id, chainId: 8453,
      spec: { kind: "open" },
      tx: { to: PROPOSAL_SAFE_LOCK, value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: 0 },
      nonce: 0n, safeTxHash: PROPOSAL_HASH_LOCK, idempotencyKey: "proposal-row-lock-test", title: "Synthetic proposal",
      steps: ["Synthetic proposal"], outcome: "Synthetic", stage: "sending",
    }).returning();

    const postEntered = deferred<void>();
    const releasePost = deferred<void>();
    let postCount = 0;
    let accepted = false;
    const live = { safe: PROPOSAL_SAFE_LOCK, confirmations: [], isExecuted: false } as never;
    const service = {
      listDelegates: async () => [{ safe: PROPOSAL_SAFE_LOCK, delegate: AGENT, delegator: DELEGATOR, label: "test" }],
      getMultisigTransaction: async () => accepted ? live : null,
      proposeTransaction: async () => {
        postCount += 1;
        postEntered.resolve();
        await releasePost.promise;
        accepted = true;
      },
    } as unknown as SafeService;
    const services = {
      safeService: () => service,
      signer: {
        address: AGENT,
        signProposal: async () => ({ safeTxHash: PROPOSAL_HASH_LOCK, signature: PROPOSAL_SIGNATURE }),
      },
    } as unknown as Services;

    const first = deliver(world.dbA, services, proposal!, PROPOSAL_SAFE_LOCK);
    await postEntered.promise;
    const second = deliver(world.dbB, services, proposal!, PROPOSAL_SAFE_LOCK);
    try {
      // The committed intent is visible to the second session while the first POST is parked.
      // It polls once, leaves the nonce held, and never waits behind or repeats the POST.
      const secondResult = await second;
      expect(secondResult.stage).toBe("sending");
      expect(postCount).toBe(1);
    } finally {
      releasePost.resolve();
    }

    const resultA = await first;
    const resultB = await deliver(world.dbB, services, proposal!, PROPOSAL_SAFE_LOCK);
    const [stored] = await world.dbA.select().from(proposals).where(eq(proposals.id, proposal!.id));
    expect(postCount).toBe(1);
    expect(resultA.stage).toBe("queued");
    expect(resultB.stage).toBe("queued");
    expect(stored?.stage).toBe("queued");
  });
});
