// In-process fake of the Transaction Service for tests and MOCK=1. It enforces what the real
// service enforced in the spikes (M0-1, M0-3), including NOT refusing to delete a confirmed
// proposal: our server has to check that itself.
import { recoverTypedDataAddress, type Hex } from "viem";
import type { Address, ChainId, SafeTx } from "@/shared/types";
import { currentTotp, delegateTypedData, deleteRequestTypedData, safeTxHash as computeSafeTxHash } from "./hash";
import { preValidatedSignature, recoverSafeSignature } from "./signature";
import {
  SafeServiceError,
  type Confirmation,
  type Delegate,
  type MultisigTransaction,
  type SafeInfo,
  type SafeService,
} from "./service-client";

const lc = (a: string) => a.toLowerCase();

type StoredTx = MultisigTransaction & { _safe: Address };
type SafeRec = { address: Address; owners: Address[]; threshold: number; nonce: number };

export class FakeSafeService implements SafeService {
  private safes = new Map<string, SafeRec>();
  private delegates: (Delegate & { safe: Address })[] = [];
  private txs = new Map<string, StoredTx>();
  /** Injectable clock for the totp window. */
  now: () => number = () => Date.now();
  private counter = 0;

  constructor(public readonly chainId: ChainId = 8453) {}

  // ---- test helpers ----
  reset() {
    this.safes.clear();
    this.delegates = [];
    this.txs.clear();
    this.counter = 0;
  }

  setOwners(safe: Address, owners: Address[], threshold: number) {
    const rec = this.safes.get(lc(safe));
    this.safes.set(lc(safe), { address: safe, owners, threshold, nonce: rec?.nonce ?? 0 });
  }

  confirm(safeTxHash: Hex, owner: Address) {
    const tx = this.mustTx(safeTxHash);
    const rec = this.safes.get(lc(tx.safe))!;
    if (!rec.owners.some((o) => lc(o) === lc(owner))) throw new Error("confirm: not an owner");
    if (tx.confirmations.some((c) => lc(c.owner) === lc(owner))) return;
    tx.confirmations.push(this.confirmation(owner));
  }

  /** An owner who approved the hash on-chain (`approveHash`): the service lists it with the v=1 pre-validated signature. */
  confirmApprovedHash(safeTxHash: Hex, owner: Address) {
    const tx = this.mustTx(safeTxHash);
    if (tx.confirmations.some((c) => lc(c.owner) === lc(owner))) return;
    tx.confirmations.push({ ...this.confirmation(owner), signature: preValidatedSignature(owner) });
  }

  /** Test helper: drop the proposer's own confirmation. */
  resetConfirmations(safeTxHash: Hex) {
    this.mustTx(safeTxHash).confirmations = [];
  }

  markExecuted(safeTxHash: Hex, r: { success: boolean; txHash: Hex }) {
    const tx = this.mustTx(safeTxHash);
    tx.isExecuted = true;
    tx.isSuccessful = r.success;
    tx.transactionHash = r.txHash;
    const rec = this.safes.get(lc(tx.safe));
    if (rec) rec.nonce = Math.max(rec.nonce, tx.nonce + 1);
  }

  private mustTx(h: Hex) {
    const tx = this.txs.get(lc(h));
    if (!tx) throw new Error(`fake service: unknown safeTxHash ${h}`);
    return tx;
  }

  private confirmation(owner: Address): Confirmation {
    this.counter += 1;
    return { owner, submissionDate: new Date(this.now() + this.counter).toISOString(), signature: `0x${"11".repeat(65)}` };
  }

  private totpOk(totp: number) {
    const cur = currentTotp(this.now());
    return totp === cur || totp === cur - 1 || totp === cur + 1;
  }

  // ---- SafeService ----
  async getSafesByOwner(owner: Address): Promise<Address[]> {
    return [...this.safes.values()].filter((s) => s.owners.some((o) => lc(o) === lc(owner))).map((s) => s.address);
  }

  async getSafe(safe: Address): Promise<SafeInfo | null> {
    const s = this.safes.get(lc(safe));
    if (!s) return null;
    return { address: s.address, nonce: s.nonce, threshold: s.threshold, owners: s.owners, version: "1.4.1+L2" };
  }

  async listDelegates(safe: Address): Promise<Delegate[]> {
    return this.delegates.filter((d) => lc(d.safe) === lc(safe)).map((d) => ({ ...d }));
  }

  async addDelegate(p: { safe: Address; delegate: Address; delegator: Address; label: string; signature: Hex }) {
    const s = this.safes.get(lc(p.safe));
    if (!s) throw new SafeServiceError(404, { detail: "Safe not found" });
    if (!s.owners.some((o) => lc(o) === lc(p.delegator))) throw new SafeServiceError(422, { detail: "Delegator is not an owner" });
    await this.checkDelegateSignature(p.delegate, p.delegator, p.signature);
    if (this.delegates.some((d) => lc(d.safe) === lc(p.safe) && lc(d.delegate) === lc(p.delegate))) {
      // the real service updates the row; keep one per (safe, delegate)
      this.delegates = this.delegates.filter((d) => !(lc(d.safe) === lc(p.safe) && lc(d.delegate) === lc(p.delegate)));
    }
    this.delegates.push({ safe: p.safe, delegate: p.delegate, delegator: p.delegator, label: p.label, expiryDate: null });
  }

  async removeDelegate(p: { safe: Address; delegate: Address; delegator: Address; signature: Hex }) {
    const i = this.delegates.findIndex((d) => lc(d.safe) === lc(p.safe) && lc(d.delegate) === lc(p.delegate));
    if (i < 0) throw new SafeServiceError(404, { detail: "Delegate not found" });
    const s = this.safes.get(lc(p.safe));
    if (!s || !s.owners.some((o) => lc(o) === lc(p.delegator))) throw new SafeServiceError(422, { detail: "Delegator is not an owner" });
    await this.checkDelegateSignature(p.delegate, p.delegator, p.signature);
    this.delegates.splice(i, 1);
  }

  private async checkDelegateSignature(delegate: Address, delegator: Address, signature: Hex) {
    // Accept the current, previous or next hour (clock skew), like the real service.
    const cur = currentTotp(this.now());
    for (const totp of [cur, cur - 1, cur + 1]) {
      try {
        const who = await recoverTypedDataAddress({ ...delegateTypedData(this.chainId, delegate, totp), signature });
        if (lc(who) === lc(delegator)) return;
      } catch { /* try next */ }
    }
    throw new SafeServiceError(422, { detail: "Signature does not match the delegator" });
  }

  async proposeTransaction(p: {
    safe: Address;
    tx: SafeTx;
    safeTxHash: Hex;
    sender: Address;
    signature: Hex;
    origin?: string | Record<string, unknown>;
  }) {
    const s = this.safes.get(lc(p.safe));
    if (!s) throw new SafeServiceError(404, { detail: "Safe not found" });
    const hash = computeSafeTxHash(this.chainId, p.safe, p.tx);
    if (lc(hash) !== lc(p.safeTxHash)) throw new SafeServiceError(422, { nonFieldErrors: ["Contract-transaction-hash does not match"] });
    if (this.txs.has(lc(hash))) throw new SafeServiceError(422, { nonFieldErrors: ["Multisig transaction with this safe-tx-hash already exists"] });
    const isOwner = s.owners.some((o) => lc(o) === lc(p.sender));
    const delegate = this.delegates.find((d) => lc(d.safe) === lc(p.safe) && lc(d.delegate) === lc(p.sender));
    if (!isOwner && !delegate) throw new SafeServiceError(422, { nonFieldErrors: ["Sender is not an owner or delegate"] });
    const signer = await recoverSafeSignature(hash, p.signature);
    if (!signer || lc(signer) !== lc(p.sender)) throw new SafeServiceError(422, { nonFieldErrors: ["Signature does not match sender"] });

    const origin = p.origin === undefined ? null : typeof p.origin === "string" ? p.origin : JSON.stringify(p.origin);
    this.txs.set(lc(hash), {
      _safe: p.safe,
      safe: p.safe,
      to: p.tx.to,
      value: p.tx.value,
      data: p.tx.data,
      operation: p.tx.operation,
      safeTxGas: p.tx.safeTxGas,
      baseGas: p.tx.baseGas,
      gasPrice: p.tx.gasPrice,
      gasToken: p.tx.gasToken,
      refundReceiver: p.tx.refundReceiver,
      nonce: Number(p.tx.nonce),
      safeTxHash: hash,
      // a delegate proposal reports the delegator as proposer (M0-1)
      proposer: isOwner ? p.sender : delegate!.delegator,
      proposedByDelegate: isOwner ? null : delegate!.delegate,
      origin,
      isExecuted: false,
      isSuccessful: null,
      transactionHash: null,
      // an owner proposal carries the owner's confirmation (1/2 in M0-1)
      confirmations: isOwner ? [this.confirmation(p.sender)] : [],
      submissionDate: new Date(this.now()).toISOString(),
    });
  }

  async confirmTransaction(p: { safeTxHash: Hex; signature: Hex }) {
    const tx = this.txs.get(lc(p.safeTxHash));
    if (!tx) throw new SafeServiceError(404, { detail: "No MultisigTransaction matches the given query." });
    if (tx.isExecuted) throw new SafeServiceError(422, { nonFieldErrors: ["Transaction already executed"] });
    const hash = computeSafeTxHash(this.chainId, tx.safe, this.asSafeTx(tx));
    const signer = await recoverSafeSignature(hash, p.signature);
    if (!signer) throw new SafeServiceError(422, { nonFieldErrors: ["Signature is not valid"] });
    const rec = this.safes.get(lc(tx.safe));
    if (!rec || !rec.owners.some((o) => lc(o) === lc(signer))) throw new SafeServiceError(422, { nonFieldErrors: ["Signer is not an owner of the Safe"] });
    if (tx.confirmations.some((c) => lc(c.owner) === lc(signer))) throw new SafeServiceError(422, { nonFieldErrors: ["Signature for this owner already exists"] });
    tx.confirmations.push({ ...this.confirmation(signer), signature: p.signature });
  }

  private asSafeTx(tx: StoredTx): SafeTx {
    return {
      to: tx.to, value: tx.value, data: (tx.data ?? "0x") as Hex, operation: tx.operation, safeTxGas: String(tx.safeTxGas),
      baseGas: String(tx.baseGas), gasPrice: tx.gasPrice, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: String(tx.nonce),
    };
  }

  async getMultisigTransaction(safeTxHash: Hex): Promise<MultisigTransaction | null> {
    const tx = this.txs.get(lc(safeTxHash));
    if (!tx) return null;
    const { _safe, ...rest } = tx;
    void _safe;
    return structuredClone(rest);
  }

  async deleteTransaction(safeTxHash: Hex, signature: Hex) {
    const tx = this.txs.get(lc(safeTxHash));
    if (!tx) throw new SafeServiceError(404, { detail: "No MultisigTransaction matches the given query." });
    if (tx.isExecuted) throw new SafeServiceError(400, { detail: "Executed transactions cannot be deleted" });
    const cur = currentTotp(this.now());
    let signer: Address | null = null;
    for (const totp of [cur, cur - 1, cur + 1]) {
      try {
        const who = await recoverTypedDataAddress({ ...deleteRequestTypedData(this.chainId, tx.safe, tx.safeTxHash, totp), signature });
        const allowed = [tx.proposedByDelegate, tx.proposer].filter(Boolean).map((a) => lc(a!));
        if (allowed.includes(lc(who))) { signer = who; break; }
      } catch { /* try next */ }
    }
    if (!signer) throw new SafeServiceError(422, { detail: "Signature is not from the proposer or the proposing delegate" });
    // NOTE: like the real service (M0-3), a confirmed proposal is deleted anyway.
    this.txs.delete(lc(safeTxHash));
  }

  // ---- HTTP ----
  /** A fetch-compatible handler for the same endpoints, so the real client can run against the fake. */
  handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const json = (status: number, body?: unknown) =>
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const readBody = async () => {
      try { return (await req.json()) as Record<string, any>; } catch { return {}; }
    };
    try {
      let m: RegExpMatchArray | null;
      if (req.method === "GET" && (m = path.match(/^\/api\/v1\/owners\/(0x[0-9a-fA-F]{40})\/safes\/$/))) {
        return json(200, { safes: await this.getSafesByOwner(m[1] as Address) });
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/v1\/safes\/(0x[0-9a-fA-F]{40})\/$/))) {
        const s = await this.getSafe(m[1] as Address);
        return s ? json(200, s) : json(404, { detail: "Not found." });
      }
      if (req.method === "GET" && path === "/api/v2/delegates/") {
        const results = await this.listDelegates((url.searchParams.get("safe") ?? "") as Address);
        return json(200, { count: results.length, next: null, previous: null, results });
      }
      if (req.method === "POST" && path === "/api/v2/delegates/") {
        const b = await readBody();
        await this.addDelegate({ safe: b.safe, delegate: b.delegate, delegator: b.delegator, label: b.label, signature: b.signature });
        return json(201, { safe: b.safe, delegate: b.delegate, delegator: b.delegator, label: b.label, expiryDate: null });
      }
      if (req.method === "DELETE" && (m = path.match(/^\/api\/v2\/delegates\/(0x[0-9a-fA-F]{40})\/$/))) {
        const b = await readBody();
        await this.removeDelegate({ safe: b.safe, delegate: m[1] as Address, delegator: b.delegator, signature: b.signature });
        return json(204);
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/v2\/safes\/(0x[0-9a-fA-F]{40})\/multisig-transactions\/$/))) {
        const b = await readBody();
        await this.proposeTransaction({
          safe: m[1] as Address,
          tx: {
            to: b.to, value: String(b.value), data: b.data ?? "0x", operation: b.operation,
            safeTxGas: String(b.safeTxGas), baseGas: String(b.baseGas), gasPrice: String(b.gasPrice),
            gasToken: b.gasToken, refundReceiver: b.refundReceiver, nonce: String(b.nonce),
          },
          safeTxHash: b.contractTransactionHash,
          sender: b.sender,
          signature: b.signature,
          origin: b.origin ?? undefined,
        });
        return json(201); // empty body, like the real service
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/v1\/multisig-transactions\/(0x[0-9a-fA-F]{64})\/$/))) {
        const tx = await this.getMultisigTransaction(m[1] as Hex);
        return tx ? json(200, tx) : json(404, { detail: "No MultisigTransaction matches the given query." });
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/v1\/multisig-transactions\/(0x[0-9a-fA-F]{64})\/confirmations\/$/))) {
        const b = await readBody();
        await this.confirmTransaction({ safeTxHash: m[1] as Hex, signature: b.signature });
        return json(201, { signature: b.signature });
      }
      if (req.method === "DELETE" && (m = path.match(/^\/api\/v1\/multisig-transactions\/(0x[0-9a-fA-F]{64})\/$/))) {
        const b = await readBody();
        await this.deleteTransaction(m[1] as Hex, b.signature);
        return json(204);
      }
      return json(404, { detail: "Not found." });
    } catch (e) {
      if (e instanceof SafeServiceError) return json(e.status, e.body);
      return json(500, { detail: String(e) });
    }
  };
}

