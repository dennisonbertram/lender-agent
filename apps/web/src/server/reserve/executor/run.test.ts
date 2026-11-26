// Executor review fixes (BP-41, BP-42): only the Aave loan is repaid; a broadcast hash is never lost; a failed email is retried.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activity, messages, reservePolicyChanges, reserveRuns, users } from "@/server/db/schema";
import type { EmailProvider } from "@/server/email/provider";
import { emailBackoffMs } from "@/server/alerts/deliver";
import { createTestWorld, type TestWorld } from "../../../../tests/helpers/world";
import { saveLink } from "../../../../tests/helpers/reserve-setup";
import { safeContext } from "@/server/request";
import { DevExecutorSigner } from "../signer";
import { turnReserveOff } from "../policy-change";
import type { ExecLink } from "../types";
import type { LoanPosition } from "@/shared/types";
import type { Hex } from "viem";
import type { PreparedRepay, PrepareResult, ReceiptResult, ReserveChain } from "./chain";
import { setReserveRuntimeForTests } from "./runtime";
import { executeReserve, reserveOnSnapshot } from "./run";
import { loadReserveLink, stopReserve } from "./store";

const MAIN = "0x00000000000000000000000000000000000000a1" as const;
const RESERVE = "0x00000000000000000000000000000000000000b2" as const;
const OWNER = "0x00000000000000000000000000000000000000c3" as const;
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const HASH = `0x${"ab".repeat(32)}` as const;
const RAW = `0x${"cd".repeat(70)}` as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const position = (lender: LoanPosition["lender"], hf: number, debt = 1000): LoanPosition => ({
  chainId: 8453, safe: MAIN, lender, id: `8453:${MAIN}:${lender}`, healthFactor: hf, liquidationThreshold: 0.8, ltv: 0.7, mixed: false, blockNumber: 1n,
  collateral: [{ asset: "WETH", token: RESERVE, amount: 1, usd: (hf * debt) / 0.8 }], debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
});

let w: TestWorld;
let safeId: number;
let link: ExecLink;
let balance = 20_000_000_000n;
// The durable broadcast seam: tests replace these to inject failures deterministically.
let prepareImpl: ((l: ExecLink, a: bigint, n: number) => Promise<PrepareResult>) | undefined;
let submitImpl: ReserveChain["submit"] | undefined;
let waitImpl: ((hash: Hex) => Promise<ReceiptResult>) | undefined;
let receiptImpl: ReserveChain["receipt"] = async () => null;
let nonceImpl: (() => Promise<number>) | undefined;
const prepare = vi.fn();
const prepared: PreparedRepay[] = [];
const submitted: PreparedRepay[] = [];
const operatorAlert = vi.fn();
const sends: string[] = [];
let sendFails = 0;
const email: EmailProvider = { send: async (m: { to: string }) => { if (sendFails > 0) { sendFails--; throw new Error("provider down"); } sends.push(m.to); } } as never;
const chain: ReserveChain = {
  read: async () => ({ allowance: { refill: 20_000_000_000n, maxRefill: 20_000_000_000n, period: 86_400n, balance: 20_000_000_000n, timestamp: 1_000n }, nowSec: 1_000, balance, executorIsMember: true, policyAsDesigned: true }),
  wasExecuted: async () => false,
  blockNumber: async () => 1n,
  nonce: async () => nonceImpl ? nonceImpl() : 0,
  prepare: async (l, a, n) => {
    prepare(l, a, n);
    const r = prepareImpl
      ? await prepareImpl(l, a, n)
      : { ok: true as const, tx: { raw: `${RAW}${n.toString(16)}` as Hex, hash: `${HASH.slice(0, -2)}${n.toString(16).padStart(2, "0")}` as Hex, nonce: n } };
    if (r.ok) prepared.push(r.tx);
    return r;
  },
  submit: async (l, tx) => { if (submitImpl) return submitImpl(l, tx); submitted.push(tx); },
  waitReceipt: async (_l, transactionHash) => waitImpl ? waitImpl(transactionHash) : { status: "success", blockNumber: 2n, transactionHash },
  receipt: (...a) => receiptImpl(...a),
  repay: async () => { throw new Error("the executor uses prepare/submit, not repay"); },
};
// What the chain "sees" when the gate re-reads the position inside the lock: it must still justify the
// claimed amount, so it mirrors the position each tick feeds in (below the trigger, same debt).
let live = position("aave-v3", 1.05);
let now = 0;
const deps = () => ({
  db: w.db, now: new Date(Date.UTC(2026, 0, 1) + (now += 60_000 * 10)), log: () => {}, email,
  reader: { readAavePosition: async () => ({ position: live }), readSafeOwners: async () => [OWNER] } as never,
});
const runs = () => w.db.select().from(reserveRuns);

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MAIN);
  link = { safeId, chainId: 8453, mainSafe: MAIN, reserveSafe: RESERVE, roles: "0x00000000000000000000000000000000000000d4", executor: "0x00000000000000000000000000000000000000e5", token: USDC, tokenSymbol: "USDC", tokenDecimals: 6, trigger: 1.3, attempt: 0, active: true, fromBlock: 1n };
  await saveLink(w.db, link);
  await w.db.insert(users).values({ address: OWNER, email: "owner@example.com" });
  prepare.mockReset(); operatorAlert.mockReset(); sends.length = 0; sendFails = 0; now = 0;
  prepared.length = 0; submitted.length = 0;
  prepareImpl = undefined; submitImpl = undefined; waitImpl = undefined; nonceImpl = undefined;
  receiptImpl = async () => null;
  live = position("aave-v3", 1.05);
  setReserveRuntimeForTests({ chain, signer: new DevExecutorSigner(KEY), operatorAlert });
});
afterEach(() => { setReserveRuntimeForTests(undefined); w.reset(); });

describe("only the Aave loan is repaid", () => {
  it("never requests more USDC than the amount the owner confirmed for Use reserve now", async () => {
    const maxAmountRaw = 1_000_000n;
    const out = await executeReserve(deps(), {
      link, position: position("aave-v3", 1.05), origin: "now", authorizedBy: OWNER,
      maxAmountRaw,
    } as never);
    expect(out.status).toBe("done");
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![1]).toBeLessThanOrEqual(maxAmountRaw);
  });

  it.each(["compound-v3", "morpho-blue"] as const)("%s below the trigger: no repay", async (lender) => {
    await reserveOnSnapshot(deps(), { safeId, position: position(lender, 1.05) });
    expect(prepare).not.toHaveBeenCalled();
    expect(await runs()).toHaveLength(0);
  });
  it("aave-v3 below the trigger repays", async () => {
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    expect(prepare).toHaveBeenCalledOnce();
    expect(submitted).toHaveLength(1);
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: prepared[0]!.hash });
  });
});

describe("a hash is never lost after broadcast", () => {
  it("a receipt error leaves the run pending with its hash and says nothing moved nowhere", async () => {
    waitImpl = async () => null; // sent, but the receipt could not be read in time
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "pending", txHash: prepared[0]!.hash, signedTx: prepared[0]!.raw });
    const text = JSON.stringify(await w.db.select().from(messages)) + JSON.stringify(await w.db.select().from(activity));
    expect(text).not.toContain("Nothing moved");
    expect(text).not.toContain("nothing moved");
  });
  it("the next tick reconciles a mined success from the hash", async () => {
    waitImpl = async () => null;
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    receiptImpl = async (_l, transactionHash) => ({ status: "success", blockNumber: 2n, transactionHash });
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    expect(prepare).toHaveBeenCalledOnce(); // no second repay is prepared
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: prepared[0]!.hash });
    expect(await w.db.select().from(activity).where(eq(activity.safeId, safeId))).toHaveLength(1);
    expect(JSON.stringify(await w.db.select().from(messages))).toContain("Repaid");
    expect(sends).toEqual(["owner@example.com"]);
  });
  it("the next tick reconciles a revert into the failure path", async () => {
    waitImpl = async () => null;
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    receiptImpl = async (_l, transactionHash) => ({ status: "reverted", blockNumber: 2n, transactionHash });
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    expect((await runs())[0]).toMatchObject({ status: "failed", txHash: prepared[0]!.hash });
    expect(operatorAlert).toHaveBeenCalled();
  });
  it("still unknown: stays pending and resubmits the identical bytes, never a new transaction", async () => {
    waitImpl = async () => null;
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    expect(prepare).toHaveBeenCalledOnce();
    expect(new Set(submitted.map((t) => t.hash))).toEqual(new Set([prepared[0]!.hash]));
    expect(new Set(submitted.map((t) => t.raw))).toEqual(new Set([prepared[0]!.raw]));
    expect((await runs())[0].status).toBe("pending");
  });
});

describe("turn-off is serialized against a broadcast on the link row lock", () => {
  it("when the send wins, turn-off refuses before the receipt wait and succeeds on retry after settlement", async () => {
    // The real turn-off path: the wallet must own the main Safe (fixture) and the Reserve Safe needs a nonce.
    const fx = w.services.fixture;
    fx.setOwners(8453, MAIN, [OWNER], 1);
    fx.setOwners(8453, RESERVE, [OWNER], 1);
    const { cookie } = await w.signIn(OWNER);
    const ctx = await safeContext(w.req("/", { cookie }), MAIN, w.services);

    // `submit` runs inside the link row lock after intent commits. Pausing it holds the lock open,
    // so turn-off queues behind the bounded send RPC. The receipt wait gets its own gate: turn-off must
    // return while the receipt is still outstanding.
    let submitEntered = false;
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((r) => { releaseSubmit = r; });
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((r) => { releaseWait = r; });
    let waitEntered = false;
    submitImpl = async (_l, tx) => { submitEntered = true; await submitGate; submitted.push(tx); };
    waitImpl = async (transactionHash) => { waitEntered = true; await waitGate; return { status: "success", blockNumber: 2n, transactionHash }; };
    const tick = reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    await vi.waitFor(() => expect(submitEntered).toBe(true)); // the send RPC is in flight under the lock

    let offSettled = false;
    const off = turnReserveOff(ctx, 8453).catch((error: unknown) => error).finally(() => { offSettled = true; });
    expect(await Promise.race([off.then(() => "returned"), new Promise<string>((r) => setTimeout(() => r("waiting"), 25))])).toBe("waiting");
    expect(offSettled).toBe(false); // turn-off waits for the in-flight submission RPC, nothing more

    releaseSubmit(); // the send lands and the lock frees
    await vi.waitFor(() => expect(waitEntered).toBe(true)); // the receipt wait has begun, outside the lock
    const offResult = await off; // turn-off returns while the receipt is still outstanding
    expect(offSettled).toBe(true);
    expect(offResult).toMatchObject({ status: 409, message: expect.stringMatching(/pending.*retry.*support/i) });
    expect((await runs())[0]).toMatchObject({ status: "pending", txHash: prepared[0]!.hash, signedTx: prepared[0]!.raw, nonce: 0 });
    expect((await loadReserveLink(w.db, safeId, 8453))!.active).toBe(true);
    expect(await w.db.select().from(reservePolicyChanges)).toHaveLength(0);

    releaseWait();
    await tick;
    expect((await runs())[0]).toMatchObject({ status: "done", txHash: prepared[0]!.hash });
    expect(await turnReserveOff(ctx, 8453)).toMatchObject({ permission: { agent: "stopped" } });
    expect((await loadReserveLink(w.db, safeId, 8453))!.active).toBe(false);

    // A stale executor view (link still says active) can claim a tick but the locked re-read drops it: no broadcast.
    prepare.mockClear();
    const out = await executeReserve(deps(), { link, position: position("aave-v3", 1.01), origin: "auto" });
    expect(out).toMatchObject({ status: "skipped", reason: "off" });
    expect(prepare).not.toHaveBeenCalled();
    expect(await runs()).toHaveLength(1);
  });

  it("turn-off cancels a signed handoff before intent commits and releases the nonce", async () => {
    // Queue turn-off under the same lock as preparation so it runs after the handoff commits.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    prepareImpl = async (_l, _a, n) => { await gate; return { ok: true, tx: { raw: RAW, hash: HASH, nonce: n } }; };
    const tick = reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());

    const off = stopReserve(w.db, safeId, 8453).catch((error: unknown) => error);
    expect(await Promise.race([off.then(() => "returned"), new Promise<string>((r) => setTimeout(() => r("waiting"), 25))])).toBe("waiting");

    release();
    expect(await off).toBe(true);
    await tick;
    expect(submitted).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ status: "failed", txHash: null, signedTx: null, nonce: null, broadcastAt: null });
    await executeReserve(deps(), { link, position: position("aave-v3", 1.01), origin: "auto" });
    expect(submitted).toHaveLength(0);
  });

  it("refuses shutdown when a legacy pending row has no broadcast evidence", async () => {
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: position("aave-v3", 1.05).id, key: "auto:legacy", status: "pending",
      requestedRaw: "1000000", hfBefore: 1.05, origin: "auto",
    });
    await expect(stopReserve(w.db, safeId, 8453)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/pending.*retry.*support/i) });
    expect((await loadReserveLink(w.db, safeId, 8453))!.active).toBe(true);
  });

  it("a live claimed run (not yet handed off) blocks a duplicate claim", async () => {
    await w.db.insert(reserveRuns).values({ safeId, chainId: 8453, loanId: `8453:${MAIN}:aave-v3`.toLowerCase(), key: "auto:lost:1", status: "pending", requestedRaw: "1000000", hfBefore: 1.2, origin: "auto", leaseExpiresAt: new Date(Date.now() + 600_000) });
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    expect(prepare).not.toHaveBeenCalled(); // fail closed: a live claim is an in-flight repay
    expect(await runs()).toHaveLength(1);
  });
});

describe("a failed email is retried", () => {
  it("transient failure, then success on a later tick (once per owner)", async () => {
    sendFails = 1;
    await reserveOnSnapshot(deps(), { safeId, position: position("aave-v3", 1.05) });
    expect(sends).toEqual([]);
    expect((await runs())[0].emailPlannedAt).toBeNull();
    // Before the backoff has passed: nothing is sent.
    const early = { ...deps(), now: new Date(Date.UTC(2026, 0, 1) + 60_000 * 10 + 1000) };
    await reserveOnSnapshot(early, { safeId, position: position("aave-v3", 2) });
    expect(sends).toEqual([]);
    const later = { ...deps(), now: new Date(Date.UTC(2026, 0, 2)) };
    await reserveOnSnapshot(later, { safeId, position: position("aave-v3", 2) });
    expect(sends).toEqual(["owner@example.com"]);
    await reserveOnSnapshot({ ...deps(), now: new Date(Date.UTC(2026, 0, 3)) }, { safeId, position: position("aave-v3", 2) });
    expect(sends).toHaveLength(1);
    expect((await runs())[0].emailPlannedAt).not.toBeNull();
    expect(emailBackoffMs(1)).toBeGreaterThan(0);
  });
});
