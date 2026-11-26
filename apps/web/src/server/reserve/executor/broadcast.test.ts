// The durable broadcast protocol (BP-52): deterministic failure injection. Every scenario is driven through
// the real executor path (`executeReserve` / `reserveOnSnapshot` on a PGlite db) with only the chain seam
// stubbed — the same stubbed points where a crash or a lost RPC acknowledgement would occur in production.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activity, messages, reserveLinks, reserveRuns, users } from "@/server/db/schema";
import { createTestWorld, type TestWorld } from "../../../../tests/helpers/world";
import { saveLink } from "../../../../tests/helpers/reserve-setup";
import { DevExecutorSigner } from "../signer";
import type { ExecLink } from "../types";
import type { LoanPosition } from "@/shared/types";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { setPublicClientForTests } from "@/server/chain/client";
import { repayConditions } from "../build";
import { REPAY_SELECTOR, RESERVE_ASSET, ROLE_KEY } from "../constants";
import { createViemReserveChain, type PreparedRepay, type PrepareResult, type ReceiptResult, type ReserveChain } from "./chain";
import { linkFingerprint, stopReserve } from "./store";
import { BALANCED_HF } from "@/lib/loan-math";
import { claimExpiredRun, gateHandoff, gateTarget, HANDOFF_LEASE_MS } from "./broadcast";
import { getReserveRuntime, setReserveRuntimeForTests } from "./runtime";
import { executeReserve, reconcileReserveRuns, reserveOnSnapshot } from "./run";

const MAIN = "0x00000000000000000000000000000000000000a1" as const;
const MAIN2 = "0x0000000000000000000000000000000000000aa2" as const;
const RESERVE = "0x00000000000000000000000000000000000000b2" as const;
const RESERVE2 = "0x0000000000000000000000000000000000000bb2" as const;
const ROLES = "0x00000000000000000000000000000000000000d4" as const;
const EXECUTOR = "0x00000000000000000000000000000000000000e5" as const;
const EXECUTOR2 = "0x00000000000000000000000000000000000000f6" as const;
const OWNER = "0x00000000000000000000000000000000000000c3" as const;
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const RAW = `0x${"cd".repeat(70)}` as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const position = (main: Address, hf: number, debt = 1000): LoanPosition => ({
  chainId: 8453, safe: main, lender: "aave-v3", id: `8453:${main}:aave-v3`, healthFactor: hf, liquidationThreshold: 0.8, ltv: 0.7, mixed: false, blockNumber: 1n,
  collateral: [{ asset: "WETH", token: RESERVE, amount: 1, usd: (hf * debt) / 0.8 }], debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
});
const hashOf = (n: number): Hex => `0x${"ab".repeat(31)}${n.toString(16).padStart(2, "0")}`;

let w: TestWorld;
let safeId: number;
let link: ExecLink;
let balance = 20_000_000_000n;
// The stubbed chain seam — the only places production can lose an acknowledgement or crash.
let prepareImpl: ((l: ExecLink, a: bigint, n: number) => Promise<PrepareResult>) | undefined;
let submitImpl: ReserveChain["submit"] | undefined;
let waitImpl: ((l: ExecLink, h: Hex) => Promise<ReceiptResult>) | undefined;
let receiptImpl: ReserveChain["receipt"] = async () => null;
let nonceImpl: ((executor: Address, tag: string) => Promise<number>) | undefined;
let readImpl: ((l: ExecLink) => ReturnType<ReserveChain["read"]>) | undefined;
let owners: Record<string, Address[]>;
const prepared: PreparedRepay[] = [];
const submitted: PreparedRepay[] = [];
const operatorAlert = vi.fn();
// What the chain "sees" when the gate re-reads the position inside the lock, keyed by Safe. It must still
// justify the claimed amount, so it mirrors the position each test feeds in.
let live: Record<string, LoanPosition | null>;
// Any timestamp a test plants "in the past" must precede the deps clock (which starts 2026-01-01), so
// recovery sees an expired lease / a dead claim / a broadcast past grace rather than a live one.
const PAST = new Date(Date.UTC(2025, 0, 1));
const chain: ReserveChain = {
  read: (l) => readImpl ? readImpl(l) : Promise.resolve({ allowance: { refill: 20_000_000_000n, maxRefill: 20_000_000_000n, period: 86_400n, balance: 20_000_000_000n, timestamp: 1_000n }, nowSec: 1_000, balance, executorIsMember: true, policyAsDesigned: true }),
  wasExecuted: async () => false,
  blockNumber: async () => 1n,
  nonce: async (l, tag = "pending") => nonceImpl ? nonceImpl(l.executor, tag) : submitted.length,
  prepare: async (l, a, n) => {
    const r = prepareImpl
      ? await prepareImpl(l, a, n)
      : { ok: true as const, tx: { raw: `${RAW}${n.toString(16)}` as Hex, hash: hashOf(n), nonce: n } };
    if (r.ok) prepared.push(r.tx);
    return r;
  },
  submit: async (l, tx) => { if (submitImpl) return submitImpl(l, tx); submitted.push(tx); },
  waitReceipt: async (l, h) => waitImpl ? waitImpl(l, h) : { status: "success", blockNumber: 2n, transactionHash: h },
  receipt: (...a) => receiptImpl(...a),
  repay: async () => { throw new Error("the executor uses prepare/submit, not repay"); },
};
let now = 0;
const deps = () => ({
  db: w.db, now: new Date(Date.UTC(2026, 0, 1) + (now += 60_000 * 10)), log: () => {}, email: null,
  reader: { readAavePosition: async (_c: number, s: string) => ({ position: live[s.toLowerCase()] ?? null }), readSafeOwners: async (_c: number, s: string) => owners[s.toLowerCase()] ?? [OWNER] } as never,
});
const runs = () => w.db.select().from(reserveRuns);
const unsignedClaim = async (createdAt = new Date()) => {
  const [run] = await w.db.insert(reserveRuns).values({
    safeId, chainId: 8453, loanId: position(MAIN, 1.05).id, key: "auto:expired", status: "pending",
    requestedRaw: "1000000", hfBefore: 1.05, origin: "auto", linkFingerprint: linkFingerprint(link),
    leaseExpiresAt: PAST, createdAt,
  }).returning();
  return run!;
};
const handedOffRun = async (overrides: Partial<typeof reserveRuns.$inferInsert> = {}) => {
  const [run] = await w.db.insert(reserveRuns).values({
    safeId, chainId: 8453, loanId: position(MAIN, 1.05).id, key: "auto:handed", status: "pending",
    requestedRaw: "1000000", hfBefore: 1.05, origin: "auto", linkFingerprint: linkFingerprint(link),
    signedTx: RAW, txHash: hashOf(0), nonce: 0, executorAddress: EXECUTOR, broadcastAt: PAST, ...overrides,
  }).returning();
  return run!;
};
const gateRuntime = () => ({ chain, signer: new DevExecutorSigner(KEY) });
const linkFor = (id: number, main: Address, reserve: Address): ExecLink => ({
  safeId: id, chainId: 8453, mainSafe: main, reserveSafe: reserve, roles: ROLES, executor: EXECUTOR,
  token: USDC, tokenSymbol: "USDC", tokenDecimals: 6, trigger: 1.3, attempt: 0, active: true, fromBlock: 1n,
});

const secondLink = async () => {
  const id = await w.trackSafe(MAIN2);
  const next = linkFor(id, MAIN2, RESERVE2);
  await saveLink(w.db, next);
  live[MAIN2.toLowerCase()] = position(MAIN2, 1.05);
  return next;
};

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MAIN);
  link = linkFor(safeId, MAIN, RESERVE);
  await saveLink(w.db, link);
  await w.db.insert(users).values({ address: OWNER, email: "owner@example.com" });
  operatorAlert.mockReset(); now = 0;
  prepared.length = 0; submitted.length = 0;
  prepareImpl = undefined; submitImpl = undefined; waitImpl = undefined; nonceImpl = undefined; readImpl = undefined;
  receiptImpl = async () => null;
  owners = { [MAIN.toLowerCase()]: [OWNER], [RESERVE.toLowerCase()]: [OWNER] };
  live = { [MAIN.toLowerCase()]: position(MAIN, 1.05) };
  setReserveRuntimeForTests({ chain, signer: new DevExecutorSigner(KEY), operatorAlert });
});
afterEach(() => { setReserveRuntimeForTests(undefined); setPublicClientForTests(8453, undefined); w.reset(); });

describe("the durable handoff", () => {
  it("commits hash + raw + nonce inside the gate before any RPC can see the transaction", async () => {
    // What the provider could observe at send time: the run row must already carry hash and raw. The send
    // itself now runs inside the link-row-lock transaction, so the read is queued (not awaited) inside it —
    // awaiting `db` there would deadlock the single-connection test database.
    let seenSignedAtSubmit: Promise<string | null | undefined> | undefined;
    submitImpl = async (_l, tx) => {
      seenSignedAtSubmit = runs().then((rs) => rs[0]?.signedTx);
      submitted.push(tx);
    };
    await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(await seenSignedAtSubmit).toBe(prepared[0]!.raw);
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: prepared[0]!.hash, signedTx: prepared[0]!.raw, nonce: 0, executorAddress: EXECUTOR });
    expect(prepared[0]!.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("a role refusal inside the gate fails the run without ever submitting", async () => {
    prepareImpl = async () => ({ ok: false, error: "ConditionViolation(AllowanceExceeded)", name: "ConditionViolation", detail: "AllowanceExceeded" });
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "failed" });
    expect(submitted).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ status: "failed", error: "ConditionViolation(AllowanceExceeded)" });
    expect(operatorAlert).toHaveBeenCalled();
  });
});

describe("crash after durable preparation but before submission", () => {
  it("the next tick resubmits the identical bytes and settles", async () => {
    let firstSubmit = true;
    submitImpl = async (_l, tx) => { if (firstSubmit) { firstSubmit = false; throw new Error("provider timeout: ack lost"); } submitted.push(tx); };
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "pending" });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "pending", signedTx: prepared[0]!.raw, txHash: prepared[0]!.hash });
    // The ack was lost before the provider could see it: nothing is on the node until the resubmit lands.
    receiptImpl = async (_l, transactionHash) => submitted.length > 0 ? { status: "success", blockNumber: 3n, transactionHash } : null;
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) }); // resubmits the identical bytes
    expect(new Set(submitted.map((t) => t.raw))).toEqual(new Set([prepared[0]!.raw]));
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) }); // the mined receipt settles it
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: prepared[0]!.hash });
    expect(prepared).toHaveLength(1); // never re-prepared: a second repay can never exist
  });

  it("a handed-off row left by a dead process reconciles by hash alone", async () => {
    const raw = `${RAW}0` as Hex;
    const hash = hashOf(0);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:dead:1", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto",
      signedTx: raw, txHash: hash, nonce: 0, executorAddress: EXECUTOR, broadcastAt: PAST, linkFingerprint: linkFingerprint(link),
    });
    receiptImpl = async (_l, transactionHash) => ({ status: "success", blockNumber: 3n, transactionHash });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: hash });
    expect(prepared).toHaveLength(0); // nothing was re-prepared: the dead process's work was reused
  });
});

describe("provider accepts but the acknowledgement is lost", () => {
  it("settles from the mined receipt — the same transaction, once", async () => {
    const landed = new Set<string>();
    submitImpl = async (_l, tx) => {
      landed.add(tx.hash.toLowerCase()); // the provider accepted it...
      throw new Error("connection reset"); // ...but the ack never came back
    };
    receiptImpl = async (_l, h) => landed.has(h.toLowerCase()) ? { status: "success", blockNumber: 4n, transactionHash: h } : null;
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "pending" });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: prepared[0]!.hash });
    expect(prepared).toHaveLength(1);
    expect(landed.size).toBe(1); // one repayment, provably one transaction
  });
});

describe("crash after submission but before the receipt", () => {
  it("stays pending through unconfirmed ticks, then settles done", async () => {
    waitImpl = async () => null; // the wait timed out — crash-equivalent
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "pending" });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect((await runs())[0].status).toBe("pending");
    receiptImpl = async (_l, transactionHash) => ({ status: "success", blockNumber: 5n, transactionHash });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: prepared[0]!.hash });
    expect(prepared).toHaveLength(1);
  });
});

describe("a handed-off run while the reserve is off", () => {
  it("sends committed bytes even if a previous version turned the link off", async () => {
    const raw = `${RAW}0` as Hex;
    const hash = hashOf(0);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:off:1", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto",
      signedTx: raw, txHash: hash, nonce: 0, executorAddress: EXECUTOR, broadcastAt: PAST, linkFingerprint: linkFingerprint(link),
    });
    await w.db.update(reserveLinks).set({ state: "off" }).where(eq(reserveLinks.mainSafeId, safeId));
    let receiptCalls = 0;
    receiptImpl = async () => { receiptCalls++; return null; };
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect(receiptCalls).toBe(1); // the hash is still asked about...
    expect(submitted).toMatchObject([{ raw, hash, nonce: 0 }]);
    expect((await runs())[0].status).toBe("pending"); // the first attempt can still settle by receipt
    receiptImpl = async (_l, transactionHash) => { receiptCalls++; return { status: "success", blockNumber: 3n, transactionHash }; };
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: hash });
    expect(submitted).toHaveLength(1); // a matching receipt ends retries
  });
});

describe("re-link before broadcast", () => {
  it("a run claimed under an older generation is refused, never signed", async () => {
    const fp = linkFingerprint(link);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:stale:1", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", linkFingerprint: fp, leaseExpiresAt: PAST,
    });
    // The owners re-linked before the gate ran: attempt bumps, generation changes.
    await w.db.update(reserveLinks).set({ attempt: sql`${reserveLinks.attempt} + 1`, updatedAt: new Date() }).where(eq(reserveLinks.mainSafeId, safeId));
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    const [run] = await runs();
    expect(run.status).toBe("failed");
    expect(run.error).toContain("re-linked");
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("resumes a committed intent even after a re-link", async () => {
    const raw = `${RAW}0` as Hex;
    const hash = hashOf(0);
    const fp = linkFingerprint(link);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:stale:2", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto",
      signedTx: raw, txHash: hash, nonce: 0, executorAddress: EXECUTOR, broadcastAt: PAST, linkFingerprint: fp,
    });
    await w.db.update(reserveLinks).set({ attempt: sql`${reserveLinks.attempt} + 1`, updatedAt: new Date() }).where(eq(reserveLinks.mainSafeId, safeId));
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect(submitted).toMatchObject([{ raw, hash, nonce: 0 }]);
    expect((await runs())[0].status).toBe("pending");
    // The new role may still be undeployed. Its state cannot determine the old repayment.
    readImpl = async () => { throw new Error("new reserve module is not deployed"); };
    receiptImpl = async (_l, transactionHash) => ({ status: "success", blockNumber: 3n, transactionHash });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: hash, paidRaw: null, balanceLeftRaw: null });
  });
});

describe("manual authorization at the broadcast boundary", () => {
  it("a caller removed from the main Safe between ask and broadcast is refused", async () => {
    // The gate's first chain read runs under the lock: removing the owner there is "removed before broadcast".
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let readCalls = 0;
    readImpl = async (l) => {
      readCalls++;
      const base = { allowance: { refill: 20_000_000_000n, maxRefill: 20_000_000_000n, period: 86_400n, balance: 20_000_000_000n, timestamp: 1_000n }, nowSec: 1_000, balance, executorIsMember: true, policyAsDesigned: true };
      if (readCalls === 2) { owners[MAIN.toLowerCase()] = []; await gate; } // inside the gate: ownership revoked
      return base;
    };
    const pending_ = executeReserve(deps(), { link, position: position(MAIN, 1.01), origin: "now", authorizedBy: OWNER, maxAmountRaw: 20_000_000_000n });
    await vi.waitFor(() => expect(readCalls).toBe(2));
    release();
    const out = await pending_;
    expect(out).toMatchObject({ status: "failed" });
    expect((await runs())[0]).toMatchObject({ status: "failed" });
    expect((await runs())[0]!.error).toContain("owner of both Safes");
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("a caller removed only from the Reserve Safe is refused the same way", async () => {
    owners[MAIN.toLowerCase()] = [OWNER];
    owners[RESERVE.toLowerCase()] = []; // dropped between the page read and the broadcast
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.01), origin: "now", authorizedBy: OWNER, maxAmountRaw: 20_000_000_000n });
    expect(out).toMatchObject({ status: "failed" });
    expect(submitted).toHaveLength(0);
  });

  it.each(["owners", "position", "role", "allowance", "balance"])("rechecks %s after signing, before the initial submit", async (change) => {
    prepareImpl = async (_l, _a, nonce) => {
      if (change === "owners") owners[RESERVE.toLowerCase()] = [];
      if (change === "position") live[MAIN.toLowerCase()] = position(MAIN, 2);
      if (change === "role" || change === "allowance" || change === "balance") {
        readImpl = async () => ({
          allowance: { refill: 20_000_000_000n, maxRefill: 20_000_000_000n, period: 86_400n, balance: change === "allowance" ? 1n : 20_000_000_000n, timestamp: 1_000n },
          nowSec: 1_000, balance: change === "balance" ? 1n : balance, executorIsMember: change !== "role", policyAsDesigned: true,
        });
      }
      return { ok: true, tx: { raw: RAW, hash: hashOf(0), nonce } };
    };
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "now", authorizedBy: OWNER, maxAmountRaw: 20_000_000_000n });
    expect(out).toMatchObject({ status: "failed" });
    expect(submitted).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ status: "failed", signedTx: null, broadcastAt: null });
    expect(operatorAlert).toHaveBeenCalled();
  });

  it("rejects a full-repay buffer that now exceeds the Reserve Safe's raw USDC balance", async () => {
    let reads = 0;
    const fullRepayPosition = position(MAIN, 0.0000008);
    live[MAIN.toLowerCase()] = fullRepayPosition;
    readImpl = async () => {
      reads++;
      const allowance = { refill: 2_000_000_000n, maxRefill: 2_000_000_000n, period: 86_400n, balance: 2_000_000_000n, timestamp: 1_000n };
      return { allowance, nowSec: 1_000, balance: reads === 1 ? 2_000_000_000n : 1n, executorIsMember: true, policyAsDesigned: true };
    };
    const out = await executeReserve(deps(), { link, position: fullRepayPosition, origin: "now", authorizedBy: OWNER, maxAmountRaw: 2_000_000_000n });
    expect(out).toMatchObject({ status: "skipped", reason: "changed" });
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("finishes the first send when ownership changes after the intent commit", async () => {
    const db = Object.create(w.db) as typeof w.db;
    let commits = 0;
    db.transaction = async (callback, config) => {
      const result = await w.db.transaction(callback, config);
      if (++commits === 2) owners[RESERVE.toLowerCase()] = [];
      return result;
    };
    const out = await executeReserve({ ...deps(), db }, { link, position: position(MAIN, 1.05), origin: "now", authorizedBy: OWNER, maxAmountRaw: 20_000_000_000n });
    expect(owners[RESERVE.toLowerCase()]).toEqual([]);
    expect(out).toMatchObject({ status: "done" });
    expect(submitted).toEqual(prepared);
  });

  it.each(["owners", "position"])("resubmits the same bytes after %s change", async (change) => {
    const submit = vi.fn(async () => { throw new Error("ack lost"); });
    submitImpl = submit;
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "now", authorizedBy: OWNER, maxAmountRaw: 20_000_000_000n });
    expect(out).toMatchObject({ status: "pending" });
    if (change === "owners") owners[MAIN.toLowerCase()] = [];
    else live[MAIN.toLowerCase()] = position(MAIN, 2);
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
    expect((await runs())[0]).toMatchObject({ status: "pending", signedTx: prepared[0]!.raw, txHash: prepared[0]!.hash });
    expect(prepared).toHaveLength(1);
  });

  it("an automatic run has no caller and never checks ownership", async () => {
    owners[MAIN.toLowerCase()] = [];
    owners[RESERVE.toLowerCase()] = [];
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "done" });
    expect(submitted).toHaveLength(1);
  });
});

describe("the on-chain policy predicate at the broadcast gate", () => {
  const POOL = RESERVE_ASSET[8453]!.pool;
  const SENTINEL = "0x0000000000000000000000000000000000000001";
  type RoleLog = { eventName: string; args: Record<string, unknown> };
  // What a correctly set-up modifier emitted, decoded: the executor on the one role, the lender target
  // scoped, and repay pinned to the canonical conditions (USDC, allowance, variable rate, the main Safe).
  const designedEvents = (): RoleLog[] => [
    { eventName: "AssignRoles", args: { module: EXECUTOR, roleKeys: [ROLE_KEY], memberOf: [true] } },
    { eventName: "ScopeTarget", args: { roleKey: ROLE_KEY, targetAddress: POOL } },
    { eventName: "ScopeFunction", args: { roleKey: ROLE_KEY, targetAddress: POOL, selector: REPAY_SELECTOR, conditions: repayConditions(8453, MAIN), options: 0 } },
  ];
  const widenedEvents = (): RoleLog[] => [
    ...designedEvents(),
    { eventName: "AllowTarget", args: { roleKey: ROLE_KEY, targetAddress: MAIN2, options: 0 } },
  ];
  // A synthetic node for the production `createViemReserveChain().read`: real event replay, real scope
  // check, real predicate — no network. The loan, balance and allowance stay valid; only the policy moves.
  const rolesClient = (o: { events?: () => RoleLog[]; moduleEnabled?: boolean } = {}) =>
    ({
      getBlock: async () => ({ number: 10n, timestamp: 1_000n }),
      getCode: async ({ address }: { address: string }) => (address.toLowerCase() === ROLES.toLowerCase() ? "0x6000" : "0x"),
      getLogs: async () => (o.events ?? designedEvents)(),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getModulesPaginated") return [[ROLES], SENTINEL];
        if (functionName === "isModuleEnabled") return o.moduleEnabled ?? true;
        if (functionName === "allowances") return [20_000_000_000n, 20_000_000_000n, 86_400n, 20_000_000_000n, 1_000n];
        if (functionName === "balanceOf") return balance;
        if (functionName === "allowance") return 2n ** 256n - 1n;
        return 0n;
      },
    }) as unknown as PublicClient;
  const viemRead = (l: ExecLink) => createViemReserveChain().read(l);

  it.each([
    ["the role was widened beyond Pool.repay", { events: widenedEvents }],
    ["the module is no longer enabled", { moduleEnabled: false }],
  ] as const)("never signs when %s even though the executor is still a member", async (_what, opts) => {
    setPublicClientForTests(8453, rolesClient(opts));
    readImpl = viemRead;
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "failed" });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "failed", signedTx: null, txHash: null, nonce: null, broadcastAt: null });
    expect(run!.error).toMatch(/policy/i);
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("rechecks the policy after signing and releases the handoff before the first send", async () => {
    let widened = false;
    setPublicClientForTests(8453, rolesClient({ events: () => (widened ? widenedEvents() : designedEvents()) }));
    readImpl = viemRead;
    prepareImpl = async (_l, _a, nonce) => {
      widened = true; // the owners widened the role between the gate's check and the send
      return { ok: true, tx: { raw: RAW, hash: hashOf(0), nonce } };
    };
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "failed" });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "failed", signedTx: null, txHash: null, nonce: null, executorAddress: null, broadcastAt: null });
    expect(run!.error).toMatch(/policy/i);
    expect(prepared).toHaveLength(1); // signed while the policy was still the designed one
    expect(submitted).toHaveLength(0);
  });

  it("keeps the missing-member refusal the actionable error when the key is off the role", async () => {
    setPublicClientForTests(8453, rolesClient({
      events: () => [{ eventName: "AssignRoles", args: { module: EXECUTOR, roleKeys: [ROLE_KEY], memberOf: [false] } }],
    }));
    readImpl = viemRead;
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "failed" });
    expect((await runs())[0]!.error).toContain("no longer a member");
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("relays committed bytes when the policy and the health both change after intent", async () => {
    const raw = `${RAW}0` as Hex;
    const hash = hashOf(0);
    const run = await handedOffRun({ signedTx: raw, txHash: hash });
    // The module is now disabled AND the loan recovered: neither may cancel committed intent.
    setPublicClientForTests(8453, rolesClient({ moduleEnabled: false }));
    readImpl = viemRead;
    live[MAIN.toLowerCase()] = position(MAIN, 2);
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect(submitted).toMatchObject([{ raw, hash, nonce: 0 }]);
    expect((await runs())[0]).toMatchObject({ status: "pending", signedTx: raw, txHash: hash, nonce: 0 });
    expect(prepared).toHaveLength(0);
  });
});

describe("the live health factor at the broadcast gate", () => {
  it("releases the handoff without sending when Aave health recovers above the trigger after signing", async () => {
    prepareImpl = async (_l, _a, nonce) => {
      // Only the received health factor moves; collateral and debt are unchanged, so the sizing
      // estimate still says below trigger. Aave's own number is what the gate must re-check.
      live[MAIN.toLowerCase()] = { ...live[MAIN.toLowerCase()]!, healthFactor: 1.5 };
      return { ok: true, tx: { raw: RAW, hash: hashOf(0), nonce } };
    };
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "failed" });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "failed", signedTx: null, txHash: null, nonce: null, broadcastAt: null });
    expect(prepared).toHaveLength(1);
    expect(submitted).toHaveLength(0);
  });

  it("skips signing when live Aave health reaches the trigger before preparation", async () => {
    const snapshot = position(MAIN, 1.05);
    live[MAIN.toLowerCase()] = { ...snapshot, healthFactor: link.trigger };
    const out = await executeReserve(deps(), { link, position: snapshot, origin: "auto" });
    expect(out).toMatchObject({ status: "skipped", reason: "changed" });
    expect(await runs()).toHaveLength(0);
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("a manual use-now still broadcasts above the trigger when otherwise valid", async () => {
    // 1.4 is above the trigger (1.3) and below the default Watch level plus margin (1.45), so the gate still has something to repay.
    live[MAIN.toLowerCase()] = position(MAIN, 1.4);
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.4), origin: "now", authorizedBy: OWNER, maxAmountRaw: 20_000_000_000n });
    expect(out).toMatchObject({ status: "done" });
    expect(submitted).toHaveLength(1);
  });
});

describe("the repay target", () => {
  it("is the Balanced target the fix options use, with default levels", async () => {
    expect(await gateTarget(w.db, link.safeId, MAIN, link.trigger)).toBe(BALANCED_HF);
  });
  it("sizes the repay to the Balanced target", async () => {
    let amount = 0n;
    prepareImpl = async (_l, a, nonce) => { amount = a; return { ok: true, tx: { raw: RAW, hash: hashOf(0), nonce } }; };
    await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    // collateral x threshold = 1050; to land on 1.6 the debt must fall from 1000 to 656.25, so 343.75 USDC.
    expect(Number(amount) / 1e6).toBeCloseTo(1050 / 1.05 - 1050 / BALANCED_HF, 2);
  });
});

describe("recovery of a claimed run", () => {
  it("fences a stale worker both at takeover and after the new worker commits the handoff", async () => {
    const stale = await unsignedClaim();
    const current = deps();
    // A delayed worker can still hold the clock value it used to claim the row.
    const original = { ...current, now: new Date(PAST.getTime() - 1) };
    const recovered = await claimExpiredRun(w.db, stale, current.now);
    expect(recovered?.leaseExpiresAt?.getTime()).toBe(current.now.getTime() + HANDOFF_LEASE_MS);
    expect(await claimExpiredRun(w.db, stale, current.now)).toBeUndefined();
    expect((await gateHandoff(original, gateRuntime(), stale, { target: 1.4 })).kind).toBe("skipped");
    const handed = await gateHandoff(current, gateRuntime(), recovered!, { target: 1.4 });
    expect(handed.kind).toBe("handoff");
    expect((await gateHandoff(original, gateRuntime(), stale, { target: 1.4 })).kind).toBe("skipped");
    expect(prepared).toHaveLength(1);
    expect((await runs())[0]).toMatchObject({ status: "pending", signedTx: prepared[0]!.raw });
  });

  it("does not fail a run when a timeout scans the old claim but a handoff wins the write", async () => {
    const stale = await unsignedClaim(PAST);
    const current = deps();
    const recovered = await claimExpiredRun(w.db, stale, current.now);
    expect((await gateHandoff(current, gateRuntime(), recovered!, { target: 1.4 })).kind).toBe("handoff");
    // Model a monitor whose pending scan finished just before the handoff committed.
    // The timeout writes still run against the real current database row.
    const staleDb = Object.create(w.db) as typeof w.db;
    staleDb.select = ((...args: unknown[]) => {
      const query = Reflect.apply(w.db.select, w.db, args);
      if (args.length === 0) {
        const from = query.from.bind(query);
        query.from = (table: unknown) => table === reserveRuns ? { where: async () => [stale] } : from(table);
      }
      return query;
    }) as typeof w.db.select;
    await reconcileReserveRuns({ ...current, db: staleDb }, safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "pending", signedTx: prepared[0]!.raw, error: null });
    expect(operatorAlert).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps an ambiguous legacy row blocking without a failure announcement (old: %s)", async (old) => {
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id, key: "auto:legacy", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.05, origin: "auto", createdAt: old ? PAST : new Date(),
    });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    expect(await runs()).toMatchObject([{ status: "pending", signedTx: null, txHash: null, leaseExpiresAt: null }]);
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    expect(operatorAlert).toHaveBeenCalledWith(expect.stringContaining("operator"), expect.anything());
    const ownerMessages = JSON.stringify(await w.db.select().from(messages)) + JSON.stringify(await w.db.select().from(activity));
    expect(ownerMessages).not.toMatch(/nothing (was broadcast|moved)/i);
  });

  it("an expired lease is resumed end to end on the next tick — same run, no duplicate", async () => {
    const fp = linkFingerprint(link);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:claim:1", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", linkFingerprint: fp, leaseExpiresAt: PAST,
    });
    // The recovered handoff submits, and the one-shot receipt lookup the same tick finds it already mined.
    receiptImpl = async (_l, transactionHash) => ({ status: "success", blockNumber: 3n, transactionHash });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", txHash: prepared[0]!.hash });
    expect(prepared).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it("a claimed run that never finished inside the dead bound fails instead of locking the loan", async () => {
    const fp = linkFingerprint(link);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:claim:2", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", linkFingerprint: fp,
      leaseExpiresAt: PAST, createdAt: PAST,
    });
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toContain("could not be prepared in time");
    expect(prepared).toHaveLength(0);
  });
});

describe("executor nonce coordination across reserves on one chain", () => {
  it("resumes after an intent crash with its owner removed, then releases the nonce when the original transaction reverts", async () => {
    const next = await secondLink();
    const started = deps();
    prepareImpl = async (_l, _a, nonce) => ({ ok: true, tx: { raw: RAW, hash: hashOf(nonce), nonce } });
    const crashingDb = Object.create(w.db) as typeof w.db;
    let commits = 0;
    crashingDb.transaction = async (callback, config) => {
      const result = await w.db.transaction(callback, config);
      if (++commits === 2) throw new Error("worker stopped after committing submission intent");
      return result;
    };
    await expect(executeReserve({ ...started, db: crashingDb }, { link, position: position(MAIN, 1.05), origin: "now", authorizedBy: OWNER, maxAmountRaw: 20_000_000_000n }))
      .rejects.toThrow("worker stopped after committing submission intent");
    const [run] = await runs();
    expect(run).toMatchObject({ status: "pending", broadcastAt: started.now, signedTx: RAW, txHash: hashOf(0) });
    expect(submitted).toHaveLength(0);

    owners[RESERVE.toLowerCase()] = [];
    nonceImpl = async (_executor, tag) => tag === "pending" ? 1 : 0;
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "pending", txHash: run!.txHash });
    expect(submitted).toMatchObject([{ raw: RAW, hash: run!.txHash, nonce: 0 }]);
    await expect(stopReserve(w.db, safeId, 8453)).rejects.toMatchObject({ status: 409 });

    expect(await executeReserve(deps(), { link: next, position: position(MAIN2, 1.05), origin: "auto" }))
      .toMatchObject({ status: "skipped", reason: "no-room" });
    expect(prepared).toHaveLength(1);

    // The network can still enforce a role change made after commit and consume the nonce by reverting.
    receiptImpl = async (_l, transactionHash) => ({ status: "reverted", blockNumber: 3n, transactionHash });
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/reverted/i), txHash: run!.txHash });
    expect(owners[RESERVE.toLowerCase()]).toEqual([]);
    expect(await stopReserve(w.db, safeId, 8453)).toBe(true);

    expect(await executeReserve(deps(), { link: next, position: position(MAIN2, 1.05), origin: "auto" })).toMatchObject({ status: "done" });
    expect(submitted.map((tx) => tx.nonce)).toEqual([0, 1]);
  });

  it("relays an existing intent while the signing key is unavailable", async () => {
    const run = await handedOffRun();
    vi.stubEnv("EXECUTOR_SIGNER", "disabled-for-this-test");
    setReserveRuntimeForTests({ chain, operatorAlert });
    try {
      const services = { ...w.services, mock: false };
      const runtime = getReserveRuntime(services, () => {});
      await reconcileReserveRuns({ ...deps(), services, runtime }, safeId, 8453);
      expect(submitted).toMatchObject([{ raw: RAW, hash: run.txHash, nonce: 0 }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("recovers a signed handoff that crashed before intent and releases it on refusal", async () => {
    const run = await handedOffRun({ broadcastAt: null, leaseExpiresAt: PAST, origin: "now", authorizedBy: OWNER });
    owners[RESERVE.toLowerCase()] = [];
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect(await runs()).toMatchObject([{ id: run.id, status: "failed", broadcastAt: null, signedTx: null }]);
    expect(submitted).toHaveLength(0);
    expect(await stopReserve(w.db, safeId, 8453)).toBe(true);
  });

  it("two reserves sharing one key never take the same nonce", async () => {
    const link2 = await secondLink();
    const safeId2 = link2.safeId;
    const deps2 = () => ({
      db: w.db, now: new Date(Date.UTC(2026, 0, 1) + (now += 60_000 * 10)), log: () => {}, email: null,
      reader: { readAavePosition: async (_c: number, s: string) => ({ position: live[s.toLowerCase()] ?? null }), readSafeOwners: async () => [OWNER] } as never,
    });
    // Reserve A pauses inside `prepare` — it is inside the gate, past the nonce allocation lock.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let aInside = false;
    prepareImpl = async (l, _a, n) => {
      if (l.safeId === safeId) { aInside = true; await gate; } // A holds the executor's nonce lock while it signs
      return { ok: true, tx: { raw: `${RAW}${l.safeId}${n}` as Hex, hash: hashOf(n + l.safeId), nonce: n } };
    };
    const a = executeReserve(deps2(), { link, position: position(MAIN, 1.05), origin: "auto" });
    await vi.waitFor(() => expect(aInside).toBe(true)); // A is inside the gate holding the nonce lock
    const b = executeReserve(deps2(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" });
    release();
    const [outA, outB] = await Promise.all([a, b]);
    expect(outA).toMatchObject({ status: "done" });
    // If B reached the gate before A's nonce was visible, it must try on a later tick.
    if (outB.status === "skipped") {
      expect(outB.reason).toBe("no-room");
      expect(await executeReserve(deps2(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" }))
        .toMatchObject({ status: "done" });
    } else {
      expect(outB).toMatchObject({ status: "done" });
    }
    const [runA] = await w.db.select().from(reserveRuns).where(eq(reserveRuns.safeId, safeId));
    const [runB] = await w.db.select().from(reserveRuns).where(eq(reserveRuns.safeId, safeId2));
    expect(runA!.nonce).toBe(0);
    expect(runB!.nonce).toBe(1); // allocated after the network has seen A's nonce
    expect(runB!.txHash).not.toBe(runA!.txHash);
  });
});

describe("a replacement receipt", () => {
  it.each(["success", "reverted"] as const)("keeps a different transaction's %s receipt pending", async (status) => {
    waitImpl = async () => ({ status, blockNumber: 2n, transactionHash: hashOf(9) });
    const result = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(result).toMatchObject({ status: "pending", txHash: hashOf(0) });
    expect((await runs())[0]).toMatchObject({ status: "pending", txHash: hashOf(0) });
    expect(JSON.stringify(await w.db.select().from(messages))).not.toMatch(/repaid|nothing moved/i);

    // An inconsistent receipt-by-hash response also cannot settle the original hash.
    receiptImpl = async () => ({ status, blockNumber: 2n, transactionHash: hashOf(9) });
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "pending", txHash: hashOf(0) });
  });
});

describe("a handed-off run whose nonce was consumed elsewhere", () => {
  it("uses the original executor's finalized nonce after a relink", async () => {
    const run = await handedOffRun();
    await w.db.update(reserveLinks).set({ executorAddress: OWNER, attempt: 1 }).where(eq(reserveLinks.mainSafeId, safeId));
    const nonce = vi.fn(async (executor: Address) => executor === EXECUTOR ? 0 : 3);
    nonceImpl = nonce;
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect(nonce).toHaveBeenCalledWith(EXECUTOR, "finalized");
    expect((await runs())[0]).toMatchObject({ status: "pending", txHash: run.txHash });
    expect(submitted).toMatchObject([{ raw: run.signedTx, hash: run.txHash, nonce: run.nonce }]);
  });

  it("uses the receipt if it appears while checking whether the nonce was consumed", async () => {
    const run = await handedOffRun();
    let nonceRead = false;
    nonceImpl = async () => { nonceRead = true; return 1; };
    receiptImpl = async (_l, transactionHash) => nonceRead ? { status: "success", blockNumber: 2n, transactionHash } : null;
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: run.txHash });
    expect(submitted).toHaveLength(0);
  });

  it("keeps a run pending when finalized nonce advances but fallback RPCs cannot find its receipt", async () => {
    const raw = `${RAW}0` as Hex;
    const hash = hashOf(0);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:dead:2", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto",
      signedTx: raw, txHash: hash, nonce: 0, executorAddress: EXECUTOR,
      broadcastAt: PAST, linkFingerprint: linkFingerprint(link),
    });
    nonceImpl = async () => 3; // The finalized node may know about our transaction while the receipt node lags.
    await reserveOnSnapshot(deps(), { safeId, position: position(MAIN, 1.05) });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "pending", txHash: hash, error: expect.stringMatching(/finalized nonce.*operator/i) });
    expect(operatorAlert).toHaveBeenCalled();
    expect(submitted).toHaveLength(0);

    receiptImpl = async () => ({ status: "success", blockNumber: 3n, transactionHash: hash });
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: hash });
  });
});

describe("durable transaction diagnostics", () => {
  it("keeps signed bytes out of concurrent read errors on the shared RPC transport", async () => {
    const client = createPublicClient({
      transport: http("http://fixture.invalid", {
        batch: { wait: 5 },
        retryCount: 0,
        fetchFn: async () => new Response("gateway unavailable", { status: 503 }),
      }),
    });
    setPublicClientForTests(8453, client);
    try {
      const chain = createViemReserveChain();
      const [send, read] = await Promise.allSettled([
        chain.submit(link.chainId, { raw: RAW, hash: hashOf(0), nonce: 0 }),
        chain.nonce(link),
      ]);
      expect(send.status).toBe("rejected");
      expect(read.status).toBe("rejected");
      if (send.status === "rejected") expect(JSON.stringify(send.reason)).not.toContain(RAW);
      if (read.status === "rejected") expect(JSON.stringify(read.reason)).not.toContain(RAW);
    } finally {
      setPublicClientForTests(8453, undefined);
    }
  });

  it.each(["send error", "receipt timeout"])("keeps signed bytes out of logs and persisted errors after %s", async (failure) => {
    const log = vi.fn();
    if (failure === "send error") submitImpl = async (_l, tx) => { throw new Error(`RPC request params: ${tx.raw}`); };
    else waitImpl = async () => null;
    await executeReserve({ ...deps(), log }, { link, position: position(MAIN, 1.05), origin: "auto" });
    const [run] = await runs();
    expect(run?.status).toBe("pending");
    expect(JSON.stringify([log.mock.calls, operatorAlert.mock.calls, run?.error])).not.toContain(prepared[0]!.raw);
  });
});

describe("the executor nonce floor from local mined evidence", () => {
  it.each(["success", "reverted"] as const)("after the pending run's exact %s receipt, a lagging pending RPC cannot hand another reserve the same nonce", async (status) => {
    const link2 = await secondLink();
    waitImpl = async (_l, transactionHash) => ({ status: transactionHash === prepared[0]?.hash ? status : "success", blockNumber: 3n, transactionHash });
    const outA = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(outA).toMatchObject({ status: status === "success" ? "done" : "failed" });
    expect(submitted.map((t) => t.nonce)).toEqual([0]);

    // The pending-nonce RPC still reports A's nonce as free even though its receipt settled the run.
    nonceImpl = async () => 0;
    const outB = await executeReserve(deps(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" });
    expect(outB).toMatchObject({ status: "done" });
    expect(prepared.map((t) => t.nonce)).toEqual([0, 1]); // B signs only nonce 1, with different bytes
    expect(submitted.map((t) => t.nonce)).toEqual([0, 1]);
    expect(prepared[1]!.raw).not.toBe(prepared[0]!.raw);
  });

  it("a higher pending RPC nonce is preserved over the local floor", async () => {
    nonceImpl = async () => 4;
    const out = await executeReserve(deps(), { link, position: position(MAIN, 1.05), origin: "auto" });
    expect(out).toMatchObject({ status: "done" });
    expect(prepared.map((t) => t.nonce)).toEqual([4]);
  });
});

describe("the executor fence around unresolved cross-reserve evidence", () => {
  it.each(["hash-only", "no-hash"] as const)("a legacy run (%s evidence) fences the chain and stays untouched", async (evidence) => {
    const link2 = await secondLink();
    const [legacy] = await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:legacy:fence", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", ...(evidence === "hash-only" ? { txHash: hashOf(7) } : {}),
    }).returning();
    // Its sender is unknown: it could be this executor, so no fresh allocation may proceed on the chain.
    expect(await executeReserve(deps(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" }))
      .toMatchObject({ status: "skipped", reason: "no-room" });
    expect(prepared).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    const [row] = await w.db.select().from(reserveRuns).where(eq(reserveRuns.id, legacy!.id));
    expect(row).toMatchObject({ status: "pending", txHash: evidence === "hash-only" ? hashOf(7) : null, executorAddress: null, nonce: null });
  });

  it.each([
    { name: "a legacy run on another chain", row: { chainId: 42161, txHash: hashOf(8) } },
    { name: "a committed intent by a different executor", row: { signedTx: RAW, txHash: hashOf(8), nonce: 4, executorAddress: EXECUTOR2, broadcastAt: PAST } },
    { name: "an unsigned leased claim", row: { leaseExpiresAt: new Date(Date.now() + 60_000) } },
  ])("$name does not fence this executor", async ({ row }) => {
    const link2 = await secondLink();
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:nonfence", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", ...row,
    });
    expect(await executeReserve(deps(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" }))
      .toMatchObject({ status: "done" });
  });
});

describe("a legacy run needs a verified sender and nonce to settle", () => {
  it.each(["success", "reverted"] as const)("a %s receipt for the exact hash cannot settle until its identity is verified", async (status) => {
    const link2 = await secondLink();
    const LEGACY = hashOf(7);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:legacy:id", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", txHash: LEGACY,
    });
    // The receipt matches the hash but the transaction's sender and nonce cannot be confirmed: pending, still fencing.
    receiptImpl = async (_l, transactionHash) => ({ status, blockNumber: 3n, transactionHash });
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "pending", txHash: LEGACY, executorAddress: null, nonce: null });
    expect(operatorAlert).toHaveBeenCalled();
    expect(await executeReserve(deps(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" }))
      .toMatchObject({ status: "skipped", reason: "no-room" });

    // Verified sender + nonce settle the run and persist the evidence in the same write; the mined
    // nonce then floors the next allocation while the pending RPC still lags.
    receiptImpl = async (_l, transactionHash) => ({ status, blockNumber: 3n, transactionHash, executorAddress: EXECUTOR, nonce: 0 });
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: status === "success" ? "done" : "failed", txHash: LEGACY, executorAddress: EXECUTOR, nonce: 0 });
    nonceImpl = async () => 0;
    expect(await executeReserve(deps(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" })).toMatchObject({ status: "done" });
    expect(prepared.map((t) => t.nonce)).toEqual([1]);
  });

  it("a verified sender that is not this executor lifts the fence without flooring its nonce", async () => {
    const link2 = await secondLink();
    const LEGACY = hashOf(7);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position(MAIN, 1.05).id.toLowerCase(), key: "auto:legacy:other", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", txHash: LEGACY,
    });
    receiptImpl = async (_l, transactionHash) => ({ status: "success", blockNumber: 3n, transactionHash, executorAddress: EXECUTOR2, nonce: 0 });
    await reconcileReserveRuns(deps(), safeId, 8453);
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: LEGACY, executorAddress: EXECUTOR2, nonce: 0 });
    nonceImpl = async () => 0; // another executor's mined nonce does not move this executor's allocation
    expect(await executeReserve(deps(), { link: link2, position: position(MAIN2, 1.05), origin: "auto" })).toMatchObject({ status: "done" });
    expect(prepared.map((t) => t.nonce)).toEqual([0]);
  });
});

describe("verified transaction metadata on the viem receipt lookup", () => {
  const BLOCK = `0x${"ee".repeat(32)}` as Hex;
  const rpcClient = (tx: Record<string, unknown> | null, methods: string[]) => createPublicClient({
    transport: http("http://fixture.invalid", {
      retryCount: 0,
      fetchFn: async (_input, init) => {
        const req = JSON.parse(String(init?.body)) as { id: number; method: string };
        methods.push(req.method);
        const result = req.method === "eth_getTransactionReceipt"
          ? {
            transactionHash: hashOf(5), blockHash: BLOCK, blockNumber: "0x2", transactionIndex: "0x0",
            from: EXECUTOR, to: RESERVE, contractAddress: null, cumulativeGasUsed: "0x5208", gasUsed: "0x5208",
            effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
          }
          : req.method === "eth_getTransactionByHash" ? tx : null;
        return Response.json({ jsonrpc: "2.0", id: req.id, result });
      },
    }),
  });
  const baseTx = {
    hash: hashOf(5), nonce: "0x7", blockHash: BLOCK, blockNumber: "0x2", transactionIndex: "0x0",
    from: EXECUTOR, to: RESERVE, value: "0x0", gas: "0x5208", gasPrice: "0x1", input: "0x",
    maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", type: "0x2", chainId: "0x2105", accessList: [],
    v: "0x1", r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: "0x1",
  };

  it("attaches the sender and nonce only when requested and consistent with the receipt", async () => {
    const methods: string[] = [];
    setPublicClientForTests(8453, rpcClient(baseTx, methods));
    try {
      const chain = createViemReserveChain();
      expect(await chain.receipt(link, hashOf(5), true))
        .toMatchObject({ status: "success", transactionHash: hashOf(5), executorAddress: EXECUTOR, nonce: 7 });
      expect(methods).toEqual(["eth_getTransactionReceipt", "eth_getTransactionByHash"]);
      methods.length = 0;
      const plain = await chain.receipt(link, hashOf(5));
      expect(plain).toMatchObject({ status: "success", transactionHash: hashOf(5) });
      expect(plain?.executorAddress).toBeUndefined();
      expect(plain?.nonce).toBeUndefined();
      expect(methods).toEqual(["eth_getTransactionReceipt"]); // the transaction is fetched only on request
    } finally {
      setPublicClientForTests(8453, undefined);
    }
  });

  it.each([
    { name: "a different sender", tx: { from: OWNER } },
    { name: "a different hash", tx: { hash: hashOf(6) } },
    { name: "no mined block", tx: { blockHash: null, blockNumber: null, transactionIndex: null } },
    { name: "no transaction on the node", tx: null },
  ])("leaves the identity off when the transaction shows $name", async ({ tx }) => {
    const methods: string[] = [];
    setPublicClientForTests(8453, rpcClient(tx === null ? null : { ...baseTx, ...tx }, methods));
    try {
      const r = await createViemReserveChain().receipt(link, hashOf(5), true);
      expect(r).toMatchObject({ status: "success", transactionHash: hashOf(5) });
      expect(r?.executorAddress).toBeUndefined();
      expect(r?.nonce).toBeUndefined();
    } finally {
      setPublicClientForTests(8453, undefined);
    }
  });
});
