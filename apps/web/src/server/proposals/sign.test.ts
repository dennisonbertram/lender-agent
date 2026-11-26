import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress, hashTypedData, recoverAddress, slice, decodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { proposals } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_COSIGNER_KEY, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { safeTxHash, safeTxTypedData, delegateTypedData } from "@/server/safe/hash";
import { execTransactionAbi } from "@/server/safe/exec";
import { isPreValidatedFor, packSignatures, preValidatedSignature } from "@/server/safe/signature";
import { SafeServiceError } from "@/server/safe/service-client";
import { safeContext } from "@/server/request";
import type { SafeTx } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { sendLive } from "@/../tests/helpers/live-send";
import { MOCK_GAS_PRICE_WEI, MOCK_TX_GAS, networkFee, networkFeeUsd } from "@/server/simulate/fee";
import { confirmProposal, getExecuteData, getSignData, recordExecuted } from "./sign";
import { getProposal } from "./read";
import { checkStale } from "./stale";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const ownerAcct = privateKeyToAccount(MOCK_OWNER_KEY);
const coAcct = privateKeyToAccount(MOCK_COSIGNER_KEY);
let w: TestWorld;
let ownerCtx: Awaited<ReturnType<typeof safeContext>>;
let coCtx: Awaited<ReturnType<typeof safeContext>>;
const fake = () => w.services.fakes.get(8453)!;

beforeEach(async () => {
  w = await createTestWorld();
  await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  ownerCtx = await safeContext(w.req("/", { cookie: (await w.signIn(MOCK_OWNER)).cookie }), MOCK_SAFE, w.services);
  coCtx = await safeContext(w.req("/", { cookie: (await w.signIn(MOCK_COSIGNER)).cookie }), MOCK_SAFE, w.services);
  const sig: Hex = await ownerAcct.signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
});
afterEach(() => { vi.restoreAllMocks(); w.reset(); });

const queue = async (key = "d1") => {
  const r = await sendLive(ownerCtx, { draftKey: key, chainId: 8453, cash: 2000, hfIdx: 1 });
  return (await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId)))[0];
};
const sign = (acct: typeof ownerAcct, row: { tx: unknown }) => acct.signTypedData(safeTxTypedData(8453, SAFE, row.tx as SafeTx));

describe("GET sign-data", () => {
  it("returns typed data recomputed from the stored tx, hashes and the plain fields", async () => {
    const row = await queue();
    const d = await getSignData(ownerCtx, row.id);
    const tx = row.tx as SafeTx;
    expect(d.safeTxHash).toBe(safeTxHash(8453, SAFE, tx));
    expect(d.typedData.message.nonce).toBe(tx.nonce);
    expect(typeof d.typedData.message.value).toBe("string");
    expect(d.fields).toMatchObject({ chainId: 8453, safe: SAFE, to: getAddress(tx.to), nonce: tx.nonce, dataSelector: slice(tx.data, 0, 4) });
    expect(d.domainHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
    // 0x1901 ‖ domain ‖ message hashes to the safeTxHash
    const { keccak256, concatHex } = await import("viem");
    expect(keccak256(concatHex(["0x1901", d.domainHash, d.messageHash]))).toBe(d.safeTxHash);
    expect(d.canSign).toBe(true);
    expect(d.reasons).toEqual([]);
    expect(hashTypedData(safeTxTypedData(8453, SAFE, tx))).toBe(d.safeTxHash);
  });

  it("refuses with reasons: already signed, not an owner now, final, blocked (with our proposal id)", async () => {
    const first = await queue("d1");
    const second = await queue("d2");
    await confirmProposal(ownerCtx, first.id, await sign(ownerAcct, first));
    expect((await getSignData(ownerCtx, first.id)).reasons.map((r) => r.code)).toEqual(["already_signed"]);
    const blocked = await getSignData(ownerCtx, second.id);
    expect(blocked.canSign).toBe(true); // blocked is informational: signing early is normal
    expect(blocked.reasons).toEqual([expect.objectContaining({ code: "blocked", blocksSigning: false })]);
    expect(blocked.blockedBy).toEqual([expect.objectContaining({ id: first.id, nonce: String(first.nonce) })]);
    w.services.fixture.setOwners(8453, SAFE, [MOCK_COSIGNER], 1);
    await expect(getSignData(ownerCtx, second.id)).rejects.toMatchObject({ status: 403 });
    await w.db.update(proposals).set({ stage: "stale" }).where(eq(proposals.id, second.id));
    expect((await getSignData(coCtx, second.id)).reasons.map((r) => r.code)).toContain("final");
  });
});

describe("GET sign-data access", () => {
  it("403 before anything is serialized when the wallet is not an owner on that proposal's network", async () => {
    const row = await queue();
    await w.db.update(proposals).set({ chainId: 42161 }).where(eq(proposals.id, row.id));
    await expect(getSignData(ownerCtx, row.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe("POST confirm", () => {
  it("accepts an owner's signature, posts the real signature to the service and refreshes the view", async () => {
    const row = await queue();
    const signature = await sign(ownerAcct, row);
    const v = await confirmProposal(ownerCtx, row.id, signature);
    const stx = await fake().getMultisigTransaction(row.safeTxHash as Hex);
    expect(stx!.confirmations.find((c) => c.owner.toLowerCase() === MOCK_OWNER.toLowerCase())?.signature).toBe(signature);
    expect(v.signedCount).toBe(1);
    expect(v.viewerSigned).toBe(true);
    expect(v.state).toBe("waiting_for_others");
    expect(v.canSign).toBe(false);
    expect(v.owners).toEqual([{ address: MOCK_OWNER, signed: true, isYou: true }, { address: MOCK_COSIGNER, signed: false, isYou: false }]);
  });

  it("the same owner twice is a no-op: one post, same view", async () => {
    const row = await queue();
    const signature = await sign(ownerAcct, row);
    const spy = vi.spyOn(fake(), "confirmTransaction");
    await confirmProposal(ownerCtx, row.id, signature);
    const again = await confirmProposal(ownerCtx, row.id, signature);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(again.signedCount).toBe(1);
  });

  it("refuses a signature from another wallet than the session's (403)", async () => {
    const row = await queue();
    await expect(confirmProposal(ownerCtx, row.id, await sign(coAcct, row))).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a signature over a tampered transaction (403, nothing posted)", async () => {
    const row = await queue();
    const bad = { ...(row.tx as SafeTx), to: "0x000000000000000000000000000000000000dEaD" } as SafeTx;
    const spy = vi.spyOn(fake(), "confirmTransaction");
    const signature = await ownerAcct.signTypedData(safeTxTypedData(8453, SAFE, bad));
    await expect(confirmProposal(ownerCtx, row.id, signature)).rejects.toMatchObject({ status: 403 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses malformed signatures: length, v=0/1, v=31/32 (400)", async () => {
    const row = await queue();
    const good = await sign(ownerAcct, row);
    const withV = (v: string) => (good.slice(0, 130) + v) as Hex;
    for (const s of ["0x1234", good.slice(0, 130), withV("00"), withV("01"), withV("1f"), withV("20"), 5, undefined]) {
      await expect(confirmProposal(ownerCtx, row.id, s)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("refuses a wallet that is no longer an owner on chain, even with a valid signature (403)", async () => {
    const row = await queue();
    w.services.fixture.setOwners(8453, SAFE, [MOCK_COSIGNER], 1);
    await expect(confirmProposal(ownerCtx, row.id, await sign(ownerAcct, row))).rejects.toMatchObject({ status: 403 });
  });

  it("refuses when the proposal is not queued (409) or the nonce has passed (409)", async () => {
    const row = await queue();
    const signature = await sign(ownerAcct, row);
    w.services.fixture.setNonce(8453, SAFE, 5n);
    await expect(confirmProposal(ownerCtx, row.id, signature)).rejects.toMatchObject({ status: 409 });
    w.services.fixture.setNonce(8453, SAFE, 0n);
    await w.db.update(proposals).set({ stage: "rejected" }).where(eq(proposals.id, row.id));
    await expect(confirmProposal(ownerCtx, row.id, signature)).rejects.toMatchObject({ status: 409 });
  });

  it("a service that refuses answers 502, and a vanished proposal 409", async () => {
    const row = await queue();
    const signature = await sign(ownerAcct, row);
    const spy = vi.spyOn(fake(), "confirmTransaction");
    spy.mockRejectedValueOnce(new SafeServiceError(500, {}));
    await expect(confirmProposal(ownerCtx, row.id, signature)).rejects.toMatchObject({ status: 502 });
    spy.mockRejectedValueOnce(new SafeServiceError(404, {}));
    await expect(confirmProposal(ownerCtx, row.id, signature)).rejects.toMatchObject({ status: 409 });
  });
});

describe("GET execute-data", () => {
  it("under-signed: 0 signatures and the caller one short is still short (needs two)", async () => {
    const row = await queue();
    const d = await getExecuteData(ownerCtx, row.id);
    expect(d).toMatchObject({ ready: false, needs: "underSigned", data: null });
  });

  it("one owner signed, the other presses Send: the v=1 entry for msg.sender completes it", async () => {
    const row = await queue();
    await confirmProposal(coCtx, row.id, await sign(coAcct, row));
    const d = await getExecuteData(ownerCtx, row.id);
    expect(d).toMatchObject({ ready: true, needs: "ok", includesYourApproval: true, to: SAFE, chainId: 8453 });
    expect(d.signatures).toHaveLength(2 + 130 * 2);
    const entries = [d.signatures!.slice(2, 132), d.signatures!.slice(132)];
    // sorted by owner ascending
    const owners = [MOCK_OWNER, MOCK_COSIGNER].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    for (const [i, o] of owners.entries()) {
      const e = `0x${entries[i]}` as Hex;
      if (o === MOCK_OWNER) expect(isPreValidatedFor(e, MOCK_OWNER)).toBe(true);
      else expect(await recoverAddress({ hash: safeTxHash(8453, SAFE, row.tx as SafeTx), signature: e })).toBe(MOCK_COSIGNER);
    }
    const decoded = decodeFunctionData({ abi: execTransactionAbi, data: d.data! });
    expect(decoded.functionName).toBe("execTransaction");
    expect((decoded.args as unknown as unknown[])[0]).toBe(getAddress((row.tx as SafeTx).to));
    expect((decoded.args as unknown as unknown[])[9]).toBe(d.signatures);
    expect(d.gas).toBe(MOCK_TX_GAS.toString());
    expect(d.gasLimit).toBe(((MOCK_TX_GAS * 120n) / 100n).toString());
    // priced on the estimated use (as the plan prices it), not on the buffered limit
    expect(d.fee?.eth).toBe(networkFee(MOCK_TX_GAS, MOCK_GAS_PRICE_WEI, null).eth);
    // the same figure the plan's mock test run shows at the fixture's ETH price
    expect(d.fee?.usd).toBe(Math.round(networkFeeUsd(MOCK_TX_GAS, MOCK_GAS_PRICE_WEI, 3000) * 100) / 100);
    expect(d.fee?.usd).toBe(0.02);
  });

  it("threshold 1: the sender's v=1 alone is not enough; a hash-bound signature is", async () => {
    const row = await queue();
    w.services.fixture.setOwners(8453, SAFE, [MOCK_OWNER, MOCK_COSIGNER], 1);
    await w.db.update(proposals).set({ threshold: 1 }).where(eq(proposals.id, row.id));
    expect(await getExecuteData(ownerCtx, row.id)).toMatchObject({ ready: false, needs: "underSigned", signatures: null });
    await confirmProposal(ownerCtx, row.id, await sign(ownerAcct, row));
    expect(await getExecuteData(ownerCtx, row.id)).toMatchObject({ ready: true, includesYourApproval: false });
  });

  it("a removed former owner's approval is not counted in the view or in execute-data", async () => {
    const row = await queue();
    await confirmProposal(coCtx, row.id, await sign(coAcct, row));
    w.services.fixture.setOwners(8453, SAFE, [MOCK_OWNER, MOCK_STRANGER], 2);
    const v = await getProposal(ownerCtx, row.id);
    expect(v.signedCount).toBe(0);
    expect(v.canSend).toBe(false);
    expect(await getExecuteData(ownerCtx, row.id)).toMatchObject({ ready: false, needs: "underSigned" });
  });

  it("both signed: no approval entry, two real signatures, sorted", async () => {
    const row = await queue();
    await confirmProposal(ownerCtx, row.id, await sign(ownerAcct, row));
    await confirmProposal(coCtx, row.id, await sign(coAcct, row));
    const d = await getExecuteData(coCtx, row.id);
    expect(d).toMatchObject({ ready: true, includesYourApproval: false });
    const hash = safeTxHash(8453, SAFE, row.tx as SafeTx);
    const rec = await Promise.all([d.signatures!.slice(0, 132), `0x${d.signatures!.slice(132)}`].map((s) => recoverAddress({ hash, signature: s as Hex })));
    expect(BigInt(rec[0]!) < BigInt(rec[1]!)).toBe(true);
    const view = await getProposal(ownerCtx, row.id);
    expect(view.state).toBe("ready_to_send");
    expect(view.canSend).toBe(true);
  });

  it("a confirmation with a junk signature is not counted", async () => {
    const row = await queue();
    fake().confirm(row.safeTxHash as Hex, MOCK_COSIGNER); // dummy 0x1111… body
    const d = await getExecuteData(ownerCtx, row.id);
    // the junk entry is dropped; the caller's v=1 alone is still under threshold 2
    expect(d).toMatchObject({ ready: false, needs: "underSigned" });
  });

  it("blocked by an earlier nonce: names our proposal, no calldata", async () => {
    const first = await queue("d1");
    const second = await queue("d2");
    const d = await getExecuteData(ownerCtx, second.id);
    expect(d).toMatchObject({ ready: false, needs: "blocked", data: null });
    expect(d.blockedBy).toEqual([{ id: first.id, nonce: String(first.nonce), title: first.title }]);
    expect((await getProposal(ownerCtx, second.id)).state).toBe("blocked");
  });

  it("outdated when the chain nonce passed", async () => {
    const row = await queue();
    w.services.fixture.setNonce(8453, SAFE, 3n);
    expect(await getExecuteData(ownerCtx, row.id)).toMatchObject({ ready: false, needs: "outdated" });
  });

  it("a simulation revert is returned decoded and Send is not offered", async () => {
    const row = await queue();
    await confirmProposal(coCtx, row.id, await sign(coAcct, row));
    w.services.execDeps = { ...(await import("./exec-deps")).mockExecDeps, estimate: async () => ({ ok: false, error: "The signature is not valid (GS026)" }) };
    const d = await getExecuteData(ownerCtx, row.id);
    expect(d).toMatchObject({ ready: false, needs: "simulation_failed", simulation: { ok: false, error: expect.stringContaining("GS026") } });
  });

  it("only owners: a removed owner gets 403", async () => {
    const row = await queue();
    w.services.fixture.setOwners(8453, SAFE, [MOCK_COSIGNER], 1);
    await expect(getExecuteData(ownerCtx, row.id)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a stored tx with refund fields set", async () => {
    const row = await queue();
    await w.db.update(proposals).set({ tx: { ...(row.tx as SafeTx), gasPrice: "1" }, safeTxHash: safeTxHash(8453, SAFE, { ...(row.tx as SafeTx), gasPrice: "1" }) }).where(eq(proposals.id, row.id));
    expect(await getExecuteData(ownerCtx, row.id)).toMatchObject({ ready: false, needs: "refused" });
  });

  it("refuses when the stored hash does not match the stored tx", async () => {
    const row = await queue();
    await w.db.update(proposals).set({ safeTxHash: `0x${"ab".repeat(32)}` }).where(eq(proposals.id, row.id));
    expect(await getExecuteData(ownerCtx, row.id)).toMatchObject({ ready: false, needs: "refused" });
  });
});

describe("POST executed", () => {
  const txHash = `0x${"cd".repeat(32)}` as Hex;

  it("the marker keeps a proposal from going stale while the service has not indexed the execution", async () => {
    const row = await queue();
    w.services.fixture.setNonce(8453, SAFE, BigInt(row.nonce!) + 1n); // chain already ran it
    const v = await recordExecuted(ownerCtx, row.id, txHash);
    expect(v).toMatchObject({ state: "sending", pendingTxHash: txHash, canSend: false, canSign: false });
    expect(await checkStale(w.db, w.services, row.id)).toBe(false);
    expect((await w.db.select().from(proposals).where(eq(proposals.id, row.id)))[0].stage).toBe("queued");
  });

  it("without the marker the same nonce jump is stale; an expired marker does not protect", async () => {
    const row = await queue();
    w.services.fixture.setNonce(8453, SAFE, BigInt(row.nonce!) + 1n);
    await recordExecuted(ownerCtx, row.id, txHash);
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    await w.db.update(proposals).set({ testRun: { pendingExec: { txHash, at: old, by: MOCK_OWNER.toLowerCase() } } }).where(eq(proposals.id, row.id));
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
  });

  it("settles through the follower: indexed execution becomes executed", async () => {
    const row = await queue();
    await recordExecuted(ownerCtx, row.id, txHash);
    fake().markExecuted(row.safeTxHash as Hex, { success: true, txHash });
    w.services.fixture.setNonce(8453, SAFE, BigInt(row.nonce!) + 1n);
    const { refreshProposal } = await import("./follow");
    await refreshProposal(w.db, w.services, row.id);
    const v = await getProposal(ownerCtx, row.id);
    expect(v.stage).toBe("executed");
    expect(v.state).toBe("executed");
  });

  describe("receipt settles the marker", () => {
    const hashOf = (row: { tx: unknown }) => safeTxHash(8453, SAFE, row.tx as SafeTx);
    const topic = async (name: string) => (await import("viem")).keccak256((await import("viem")).toBytes(name));
    const stub = async (receipt: unknown) => {
      w.services.execDeps = { ...(await import("./exec-deps")).mockExecDeps, getReceipt: async () => receipt as never };
    };
    const refresh = async (id: string) => (await import("./follow")).refreshProposal(w.db, w.services, id);
    const reload = async (id: string) => (await w.db.select().from(proposals).where(eq(proposals.id, id)))[0];
    const setMarker = (id: string, at: Date) => w.db.update(proposals).set({ testRun: { pendingExec: { txHash, at: at.toISOString(), by: MOCK_OWNER.toLowerCase(), known: false } } }).where(eq(proposals.id, id));

    it("ExecutionSuccess for this Safe and hash: executed", async () => {
      const row = await queue();
      await recordExecuted(ownerCtx, row.id, txHash);
      await stub({ status: "success", logs: [{ address: SAFE, topics: [await topic("ExecutionSuccess(bytes32,uint256)")], data: `${hashOf(row)}${"0".repeat(64)}` }] });
      await refresh(row.id);
      expect(await reload(row.id)).toMatchObject({ stage: "executed", executedTxHash: txHash });
    });

    it("Safe 1.4.x indexes the hash (topic 1, payment in data): executed", async () => {
      const row = await queue();
      await recordExecuted(ownerCtx, row.id, txHash);
      await stub({ status: "success", logs: [{ address: SAFE, topics: [await topic("ExecutionSuccess(bytes32,uint256)"), hashOf(row)], data: `0x${"0".repeat(64)}` }] });
      await refresh(row.id);
      expect(await reload(row.id)).toMatchObject({ stage: "executed", executedTxHash: txHash });
    });

    it("an indexed event whose topic 1 is another value does not match through its data word", async () => {
      const row = await queue();
      await recordExecuted(ownerCtx, row.id, txHash);
      const other = `0x${"ab".repeat(32)}`;
      await stub({ status: "success", logs: [{ address: SAFE, topics: [await topic("ExecutionSuccess(bytes32,uint256)"), other], data: hashOf(row) }] });
      await refresh(row.id);
      expect((await reload(row.id)).stage).toBe("queued");
    });

    it("a 1.3 layout (no topic 1) does not match on a different data word", async () => {
      const row = await queue();
      await recordExecuted(ownerCtx, row.id, txHash);
      await stub({ status: "success", logs: [{ address: SAFE, topics: [await topic("ExecutionSuccess(bytes32,uint256)")], data: `0x${"ab".repeat(32)}${"0".repeat(64)}` }] });
      await refresh(row.id);
      expect((await reload(row.id)).stage).toBe("queued");
    });

    it("a reverted transaction clears the marker and records a failed attempt", async () => {
      const row = await queue();
      await recordExecuted(ownerCtx, row.id, txHash);
      await stub({ status: "reverted", logs: [] });
      await refresh(row.id);
      const after = await reload(row.id);
      expect(after.stage).toBe("queued");
      expect(after.testRun).toMatchObject({ lastAttempt: { status: "failed", txHash } });
      expect((after.testRun as Record<string, unknown>).pendingExec).toBeUndefined();
      expect((await getProposal(ownerCtx, row.id)).state).not.toBe("sending");
    });

    it("a success receipt without this Safe's event for this hash clears the marker", async () => {
      const row = await queue();
      await recordExecuted(ownerCtx, row.id, txHash);
      await stub({ status: "success", logs: [{ address: MOCK_STRANGER, topics: [await topic("ExecutionSuccess(bytes32,uint256)")], data: `${hashOf(row)}${"0".repeat(64)}` }] });
      await refresh(row.id);
      expect((await reload(row.id)).stage).toBe("queued");
      expect(((await reload(row.id)).testRun as Record<string, unknown>).pendingExec).toBeUndefined();
    });

    it("an unknown hash is believed for 5 minutes, then dropped", async () => {
      const row = await queue();
      await recordExecuted(ownerCtx, row.id, txHash);
      await stub(null);
      await refresh(row.id);
      expect((await getProposal(ownerCtx, row.id)).state).toBe("sending");
      await setMarker(row.id, new Date(Date.now() - 6 * 60_000));
      await refresh(row.id);
      expect(((await reload(row.id)).testRun as Record<string, unknown>).pendingExec).toBeUndefined();
      expect((await getProposal(ownerCtx, row.id)).state).not.toBe("sending");
    });
  });

  it("rejects a hash that is not a tx hash (400) and a tx on chain that is not this execution (400)", async () => {
    const row = await queue();
    await expect(recordExecuted(ownerCtx, row.id, "0x12")).rejects.toMatchObject({ status: 400 });
    w.services.execDeps = { ...(await import("./exec-deps")).mockExecDeps, getTransaction: async () => ({ to: SAFE, input: "0xdeadbeef" }) };
    await expect(recordExecuted(ownerCtx, row.id, txHash)).rejects.toMatchObject({ status: 400 });
    w.services.execDeps = { ...(await import("./exec-deps")).mockExecDeps, getTransaction: async () => ({ to: MOCK_STRANGER, input: "0xdeadbeef" }) };
    await expect(recordExecuted(ownerCtx, row.id, txHash)).rejects.toMatchObject({ status: 400 });
  });

  it("accepts a tx on chain that is this Safe's execTransaction for this tx", async () => {
    const row = await queue();
    const { execCalldata } = await import("@/server/safe/exec");
    const input = execCalldata(row.tx as SafeTx, packSignatures([{ owner: MOCK_OWNER, signature: preValidatedSignature(MOCK_OWNER) }]));
    w.services.execDeps = { ...(await import("./exec-deps")).mockExecDeps, getTransaction: async () => ({ to: SAFE, input }) };
    expect((await recordExecuted(ownerCtx, row.id, txHash)).state).toBe("sending");
  });
});

describe("signatures", () => {
  it("packSignatures sorts by owner ascending and v=1 entry layout is r=owner,s=0,v=1", () => {
    const a = "0x0000000000000000000000000000000000000002" as const;
    const b = "0x0000000000000000000000000000000000000001" as const;
    const sa = preValidatedSignature(a), sb = preValidatedSignature(b);
    expect(packSignatures([{ owner: a, signature: sa }, { owner: b, signature: sb }])).toBe(`${sb}${sa.slice(2)}`);
    expect(sa).toBe(`0x${"00".repeat(31)}02${"00".repeat(32)}01`);
  });
});
