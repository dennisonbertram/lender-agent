import { beforeEach, describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS } from "../../../tests/helpers/anvil";
import { deleteRequestTypedData, safeTxHash, safeTxTypedData } from "../safe/hash";
import { ANVIL_DEV_KEYS, DevSigner } from "./dev";
import { KeySigner } from "./key";
import { KmsSigner } from "./kms";
import { getSigner } from "./index";
import { createTestDb, type Db } from "@/server/db/test-db";
import { proposals, safes } from "@/server/db/schema";
import type { SafeTx } from "@/shared/types";

const safe = "0xe4aAb4dfF32aBd99e3DD577C230553503a6AC7B3" as const;
const tx: SafeTx = {
  to: "0xdead000000000000000000000000000000000000", value: "0", data: "0xabcd", operation: 1,
  safeTxGas: "0", baseGas: "0", gasPrice: "0",
  gasToken: "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000", nonce: "1",
};

let db: Db;
const getDb = async () => db;
const other = "0x0000000000000000000000000000000000000abc" as const;

async function store(id: string, o: { stage?: string; confirmations?: { owner: string; submittedAt: string }[]; chainId?: number; address?: string; hash?: string; nonce?: string; deletedFromQueue?: boolean } = {}) {
  const [s] = await db.select().from(safes);
  const safeId = s?.id ?? (await db.insert(safes).values({ address: o.address ?? safe, name: "t" }).returning())[0]!.id;
  await db.insert(proposals).values({
    id, safeId, chainId: o.chainId ?? 8453, spec: {}, tx: { ...tx, nonce: o.nonce ?? tx.nonce }, safeTxHash: o.hash ?? safeTxHash(8453, safe, { ...tx, nonce: o.nonce ?? tx.nonce }), idempotencyKey: id, title: id, steps: [], outcome: "",
    stage: o.stage ?? "sending", confirmations: o.confirmations ?? [], deletedFromQueue: o.deletedFromQueue ?? false,
  });
}

beforeEach(async () => { db = await createTestDb(); });

describe("signers", () => {
  it("lists anvil's well-known keys, including the ANVIL_KEYS used by tests", () => {
    for (const k of ANVIL_KEYS) expect(ANVIL_DEV_KEYS).toContain(k);
    expect(privateKeyToAccount(ANVIL_DEV_KEYS[9]!).address).toBe("0xa0Ee7A142d267C1f36714E4a8F75612F20a79720");
    expect(privateKeyToAccount(ANVIL_DEV_KEYS[6]!).address).toBe("0x976EA74026E726554dB657fA54763abd0C3a0aa9");
    expect(privateKeyToAccount(ANVIL_DEV_KEYS[7]!).address).toBe("0x14dC79964da2C08b23698B3D3cc7Ca32193d9955");
    expect(privateKeyToAccount(ANVIL_DEV_KEYS[8]!).address).toBe("0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f");
  });

  it("dev signer refuses a non-anvil key or a missing key", () => {
    expect(() => new DevSigner(`0x${"12".repeat(32)}`, getDb)).toThrow(/anvil/);
    expect(() => new DevSigner(undefined, getDb)).toThrow(/not set/);
    expect(() => getSigner({ PROPOSER_SIGNER: "dev", DEV_PROPOSER_KEY: `0x${"ab".repeat(32)}` })).toThrow();
  });

  it("signature recovers to the signer over the recomputed hash", async () => {
    const s = getSigner({ PROPOSER_SIGNER: "dev", DEV_PROPOSER_KEY: ANVIL_KEYS[3] }, getDb);
    await store("p1");
    const r = await s.signProposal({ proposalId: "p1", chainId: 8453, safe });
    expect(r.safeTxHash).toBe(safeTxHash(8453, safe, tx));
    const who = await recoverTypedDataAddress({ ...safeTxTypedData(8453, safe, tx), signature: r.signature });
    expect(who).toBe(s.address);
    expect(s.address).toBe(privateKeyToAccount(ANVIL_KEYS[3]).address);
  });

  it("delete request signature recovers to the signer", async () => {
    const s = new DevSigner(ANVIL_KEYS[3], getDb);
    const h = safeTxHash(8453, safe, tx);
    await store("p1", { stage: "queued" });
    const sig = await s.signDeleteRequest({ proposalId: "p1", chainId: 8453, safe, totp: 99 });
    expect(await recoverTypedDataAddress({ ...deleteRequestTypedData(8453, safe, h, 99), signature: sig })).toBe(s.address);
  });

  describe("key signer", () => {
    const key = `0x${"12".repeat(32)}`;

    it("refuses every anvil key, and a missing or malformed key, without echoing the key", () => {
      for (const k of ANVIL_DEV_KEYS) {
        expect(() => new KeySigner(k, getDb)).toThrow(/anvil/);
        expect(() => new KeySigner(k.toUpperCase().replace("0X", "0x"), getDb)).toThrow(/anvil/);
      }
      expect(() => new KeySigner(undefined, getDb)).toThrow(/not set/);
      expect(() => new KeySigner("", getDb)).toThrow(/not set/);
      for (const bad of ["0x1234", `${"12".repeat(32)}`, `0x${"zz".repeat(32)}`]) {
        let msg = "";
        try { new KeySigner(bad, getDb); } catch (e) { msg = (e as Error).message; }
        expect(msg).toMatch(/malformed/);
        expect(msg).not.toContain(bad);
      }
      // Above the curve order: passes the shape check, and viem's own error would print it in decimal.
      const outOfRange = `0x${"ff".repeat(32)}`;
      let rangeMsg = "";
      try { new KeySigner(outOfRange, getDb); } catch (e) { rangeMsg = (e as Error).message; }
      expect(rangeMsg).toBe("PROPOSER_PRIVATE_KEY is not a valid secp256k1 private key");
      let msg = "";
      try { new KeySigner(ANVIL_DEV_KEYS[0]!, getDb); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toContain(ANVIL_DEV_KEYS[0]!.slice(2));
    });

    it("getSigner picks it by PROPOSER_SIGNER=key and signs a stored proposal", async () => {
      const s = getSigner({ PROPOSER_SIGNER: "key", PROPOSER_PRIVATE_KEY: key }, getDb);
      expect(s).toBeInstanceOf(KeySigner);
      expect(s.address).toBe(privateKeyToAccount(key as `0x${string}`).address);
      await store("p1", { stage: "queued" });
      await expect(s.signProposal({ proposalId: "p1", chainId: 8453, safe })).rejects.toThrow(/cannot be signed/);
      await db.update(proposals).set({ stage: "sending" });
      const r = await s.signProposal({ proposalId: "p1", chainId: 8453, safe });
      expect(await recoverTypedDataAddress({ ...safeTxTypedData(8453, safe, tx), signature: r.signature })).toBe(s.address);
      await db.update(proposals).set({ stage: "queued" });
      const sig = await s.signDeleteRequest({ proposalId: "p1", chainId: 8453, safe, totp: 7 });
      expect(await recoverTypedDataAddress({ ...deleteRequestTypedData(8453, safe, r.safeTxHash, 7), signature: sig })).toBe(s.address);
      await expect(s.signProposal({ proposalId: "nope", chainId: 8453, safe })).rejects.toThrow(/Unknown proposal/);
    });

    it("has no sign-arbitrary-bytes method", () => {
      const m = Object.getOwnPropertyNames(KeySigner.prototype).filter((n) => n !== "constructor");
      expect(m.sort()).toEqual(["signDeleteRequest", "signProposal"]);
    });
  });

  it("has no sign-arbitrary-bytes method", () => {
    const s = new DevSigner(ANVIL_KEYS[0], getDb) as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(["signDeleteRequest", "signProposal"]);
  });

  it("KmsSigner throws not configured; getSigner picks by PROPOSER_SIGNER", async () => {
    const k = getSigner({ PROPOSER_SIGNER: "kms" }, getDb);
    expect(k).toBeInstanceOf(KmsSigner);
    await expect(k.signProposal({ proposalId: "p1", chainId: 8453, safe })).rejects.toThrow("KMS signer not configured");
    await expect(k.signDeleteRequest({ proposalId: "p1", chainId: 8453, safe, totp: 1 })).rejects.toThrow("KMS signer not configured");
    expect(() => k.address).toThrow("KMS signer not configured");
    expect(() => getSigner({ PROPOSER_SIGNER: "nope" })).toThrow(/Unknown/);
  });

  describe("signs only stored proposals", () => {
    const s = () => new DevSigner(ANVIL_KEYS[3], getDb);

    it("an unknown proposal id fails, for signing and for deletes", async () => {
      await expect(s().signProposal({ proposalId: "nope", chainId: 8453, safe })).rejects.toThrow(/Unknown proposal/);
      await expect(s().signDeleteRequest({ proposalId: "nope", chainId: 8453, safe, totp: 1 })).rejects.toThrow(/Unknown proposal/);
    });

    it("a stored proposal signs, and the signature covers the stored transaction", async () => {
      await store("p1");
      const r = await s().signProposal({ proposalId: "p1", chainId: 8453, safe });
      expect(r.safeTxHash).toBe(safeTxHash(8453, safe, tx));
    });

    it("refuses another Safe, another network, and a stage that is not signable", async () => {
      await store("p1");
      await expect(s().signProposal({ proposalId: "p1", chainId: 8453, safe: other })).rejects.toThrow(/different Safe/);
      await expect(s().signProposal({ proposalId: "p1", chainId: 84532, safe })).rejects.toThrow(/different network/);
      await db.update(proposals).set({ stage: "executed" });
      await expect(s().signProposal({ proposalId: "p1", chainId: 8453, safe })).rejects.toThrow(/cannot be signed/);
    });

    it("refuses when the stored hash does not match the stored transaction", async () => {
      await store("p1", { hash: `0x${"11".repeat(32)}` });
      await expect(s().signProposal({ proposalId: "p1", chainId: 8453, safe })).rejects.toThrow(/does not match/);
    });

    it("a delete of an unconfirmed queued proposal signs; with owner confirmations it is refused (M0-3)", async () => {
      await store("p1", { stage: "queued" });
      await store("p2", { stage: "queued", nonce: "2", confirmations: [{ owner: other, submittedAt: "2026-01-01T00:00:00Z" }] });
      const h = safeTxHash(8453, safe, tx);
      const sig = await s().signDeleteRequest({ proposalId: "p1", chainId: 8453, safe, totp: 5 });
      expect(await recoverTypedDataAddress({ ...deleteRequestTypedData(8453, safe, h, 5), signature: sig })).toBe(s().address);
      await expect(s().signDeleteRequest({ proposalId: "p2", chainId: 8453, safe, totp: 5 })).rejects.toThrow(/confirmed/);
    });

    it("allows deleting a stopped proposal only while its stored Safe hash still matches and deletion is unconfirmed", async () => {
      const s = getSigner({ PROPOSER_SIGNER: "dev", DEV_PROPOSER_KEY: ANVIL_KEYS[3] }, getDb);
      await store("stopped-pending-delete", { stage: "stopped" });
      const signature = await s.signDeleteRequest({ proposalId: "stopped-pending-delete", chainId: 8453, safe, totp: 12 });
      const h = safeTxHash(8453, safe, tx);
      expect(await recoverTypedDataAddress({ ...deleteRequestTypedData(8453, safe, h, 12), signature })).toBe(s.address);

      await store("stopped-deleted", { stage: "stopped", nonce: "2", deletedFromQueue: true });
      await expect(s.signDeleteRequest({ proposalId: "stopped-deleted", chainId: 8453, safe, totp: 12 })).rejects.toThrow(/cannot be deleted/);
      await store("stopped-bad-hash", { stage: "stopped", nonce: "3", hash: `0x${"11".repeat(32)}` });
      await expect(s.signDeleteRequest({ proposalId: "stopped-bad-hash", chainId: 8453, safe, totp: 12 })).rejects.toThrow(/does not match/);
    });

    it("refuses a delete for a proposal that is not in the queue", async () => {
      await store("p1", { stage: "draft" });
      await expect(s().signDeleteRequest({ proposalId: "p1", chainId: 8453, safe, totp: 5 })).rejects.toThrow(/cannot be deleted/);
    });
  });
});
