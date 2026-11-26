// Owners sign and execute a stored proposal on a Base fork: a 2-of-2 Safe, a proposal the agent queued
// in the fake service, owner A signing through the app's verify path, owner B sending with the v=1
// shortcut (and a second case through on-chain approveHash). Also: the simulation catches a reverting
// call without consuming the nonce, and a later nonce is reported as blocked before anything is sent.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { parseAbi, parseEther, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, safeAbi } from "../helpers/safe";
import { createAccess } from "@/server/auth/access";
import { setPublicClientForTests } from "@/server/chain/client";
import { createViemReader } from "@/server/chain/reader";
import { proposals, safes } from "@/server/db/schema";
import { chainExecDeps } from "@/server/proposals/exec-deps";
import { refreshProposal } from "@/server/proposals/follow";
import { confirmProposal, getExecuteData, recordExecuted } from "@/server/proposals/sign";
import { safeContext } from "@/server/request";
import { safeTxHash, safeTxTypedData } from "@/server/safe/hash";
import { buildSafeTx } from "@/server/safe/multisend";
import type { Services } from "@/server/services";
import type { Address, SafeTx } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../helpers/world";

const A = privateKeyToAccount(ANVIL_KEYS[0]);
const B = privateKeyToAccount(ANVIL_KEYS[1]);
const RECIPIENT = "0x000000000000000000000000000000000000bEEF" as Address;
const approveAbi = parseAbi(["function approveHash(bytes32 hashToApprove)"]);

describe("owner sign and execute on a Base fork", () => {
  let fork: Fork;
  let w: TestWorld;
  let safe: Address;
  let svc: Services;
  let ctxA: Awaited<ReturnType<typeof safeContext>>;
  let ctxB: Awaited<ReturnType<typeof safeContext>>;
  const fake = () => w.services.fakes.get(8453)!;

  beforeAll(async () => {
    let last: unknown;
    for (let i = 0; i < 3 && !fork; i++) {
      try { fork = await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
    }
    if (!fork) throw last;
    setPublicClientForTests(8453, fork.publicClient as never);
    safe = (await deployTestSafe({ fork, owners: [A.address, B.address], threshold: 2, saltNonce: "777" })).address;
    await fork.testClient.setBalance({ address: safe, value: parseEther("5") });
  }, 240_000);
  afterAll(async () => { setPublicClientForTests(8453, undefined); await fork?.stop(); });

  beforeEach(async () => {
    w = await createTestWorld();
    const reader = createViemReader();
    svc = { ...w.services, reader, access: createAccess({ readOwners: reader.readSafeOwners }), execDeps: chainExecDeps, mock: true };
    await w.trackSafe(safe);
    fake().setOwners(safe, [A.address, B.address], 2);
    ctxA = await safeContext(w.req("/", { cookie: (await w.signIn(A.address)).cookie }), safe, svc);
    ctxB = await safeContext(w.req("/", { cookie: (await w.signIn(B.address)).cookie }), safe, svc);
  });
  afterEach(() => w.reset());

  /** What the agent does: store the proposal, queue it in the service (proposed by owner A here; the service's own confirmation is cleared). */
  async function queue(id: string, tx: SafeTx) {
    const hash = safeTxHash(8453, safe, tx);
    const [row] = await w.db.select().from(safes).limit(1);
    await fake().proposeTransaction({ safe, tx, safeTxHash: hash, sender: A.address, signature: await A.signTypedData(safeTxTypedData(8453, safe, tx)) });
    // the proposer's own confirmation is not part of this scenario: start from an empty list
    fake().resetConfirmations(hash);
    await w.db.insert(proposals).values({ id, safeId: row!.id, chainId: 8453, spec: { kind: "reserve-off" }, tx, nonce: BigInt(tx.nonce), safeTxHash: hash, idempotencyKey: id, title: id, steps: [], outcome: "", stage: "queued", threshold: 2 });
    return hash;
  }
  const nonceOnChain = () => fork.publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const sendFrom = async (acct: typeof A, d: { to: Address; data: Hex; gasLimit: string | null }) => {
    const hash = await fork.walletClient.sendTransaction({ account: acct, chain: fork.chain, to: d.to, data: d.data, gas: BigInt(d.gasLimit!) });
    return fork.publicClient.waitForTransactionReceipt({ hash });
  };

  it("A signs through the verify path, B sends with the v=1 shortcut: nonce+1, balance moves, ExecutionSuccess", async () => {
    const n = await nonceOnChain();
    const tx = buildSafeTx([{ to: RECIPIENT, value: parseEther("0.25") }], Number(n));
    const hash = await queue("p-shortcut", tx);
    const before = await fork.publicClient.getBalance({ address: RECIPIENT });
    await confirmProposal(ctxA, "p-shortcut", await A.signTypedData(safeTxTypedData(8453, safe, tx)));
    const d = await getExecuteData(ctxB, "p-shortcut");
    expect(d).toMatchObject({ ready: true, includesYourApproval: true, simulation: { ok: true } });
    const receipt = await sendFrom(B, d as never);
    expect(receipt.status).toBe("success");
    const logs = parseEventLogs({ abi: safeAbi, logs: receipt.logs, eventName: "ExecutionSuccess" });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.args.txHash).toBe(hash);
    expect(await nonceOnChain()).toBe(n + 1n);
    expect((await fork.publicClient.getBalance({ address: RECIPIENT })) - before).toBe(parseEther("0.25"));
    // the hash we record is verified against the chain; the follower now matches Safe 1.4.1's indexed ExecutionSuccess (hash in topic 1), so it settles at once
    const v = await recordExecuted(ctxB, "p-shortcut", receipt.transactionHash);
    expect(v).toMatchObject({ state: "executed", executionTxHash: receipt.transactionHash });
    fake().markExecuted(hash, { success: true, txHash: receipt.transactionHash });
    await refreshProposal(w.db, svc, "p-shortcut");
    expect((await w.db.select().from(proposals))[0]!.stage).toBe("executed");
  }, 120_000);

  it("an owner who approved the hash on-chain counts with a v=1 entry, any sender", async () => {
    const n = await nonceOnChain();
    const tx = buildSafeTx([{ to: RECIPIENT, value: parseEther("0.1") }], Number(n));
    const hash = await queue("p-approve", tx);
    const ah = await fork.walletClient.writeContract({ account: A, chain: fork.chain, address: safe, abi: approveAbi, functionName: "approveHash", args: [hash] });
    await fork.publicClient.waitForTransactionReceipt({ hash: ah });
    fake().confirmApprovedHash(hash, A.address);
    const d = await getExecuteData(ctxB, "p-approve");
    expect(d).toMatchObject({ ready: true, includesYourApproval: true });
    expect((await sendFrom(B, d as never)).status).toBe("success");
    expect(await nonceOnChain()).toBe(n + 1n);
  }, 120_000);

  it("a call that would revert is caught by the simulation and the nonce is not consumed", async () => {
    const n = await nonceOnChain();
    const tx = buildSafeTx([{ to: RECIPIENT, value: parseEther("1000000") }], Number(n)); // far more than the Safe holds
    await queue("p-revert", tx);
    await confirmProposal(ctxA, "p-revert", await A.signTypedData(safeTxTypedData(8453, safe, tx)));
    const d = await getExecuteData(ctxB, "p-revert");
    expect(d).toMatchObject({ ready: false, needs: "simulation_failed", simulation: { ok: false } });
    expect(d.reason).toMatch(/GS013|failed/);
    expect(await nonceOnChain()).toBe(n);
  }, 120_000);

  it("a later nonce is blocked before anything is sent", async () => {
    const n = await nonceOnChain();
    const tx = buildSafeTx([{ to: RECIPIENT, value: 1n }], Number(n) + 1);
    await queue("p-blocked", tx);
    await confirmProposal(ctxA, "p-blocked", await A.signTypedData(safeTxTypedData(8453, safe, tx)));
    const d = await getExecuteData(ctxB, "p-blocked");
    expect(d).toMatchObject({ ready: false, needs: "blocked", data: null });
    expect(d.blockedBy.map((b) => b.nonce)).toEqual([n.toString()]);
  }, 120_000);
});
