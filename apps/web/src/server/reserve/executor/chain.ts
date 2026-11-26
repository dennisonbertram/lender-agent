// What the executor needs from the chain, behind one interface so MOCK and tests can stand in for it. Reads go
// through the canonical `readReserveChain` (one decoding of the Roles modifier); a repay is the canonical
// `buildRoleRepay` call signed by the canonical `prepareRoleCall`. Success is reported only from a mined,
// successful receipt. The durable broadcast protocol (BP-52) splits the send into `prepare` (build + sign,
// never touches the network for sending) and `submit` (broadcast only), so the deterministic hash and the raw
// signed transaction are committed to the run row before any RPC can accept the transaction.
import { parseAbiItem, type Hex } from "viem";
import { getPublicClient } from "@/server/chain/client";
import { buildRoleRepay } from "../build";
import { policyAsDesigned, readReserveChain } from "../read";
import { prepareRoleCall, submitSignedRoleCall, type ExecutorSigner } from "../signer";
import type { RawAllowance } from "../allowance";
import type { Address, ChainId } from "@/shared/types";
import type { ExecLink } from "../types";
import { decodeRolesFailure } from "./failure";

/** `pending`: the transaction was broadcast (`txHash`) but its receipt could not be read; it may still land. */
export type RepayResult = { ok: true; txHash: Hex; blockNumber: bigint } | { ok: false; error: string; name: string; detail: string | null; pending?: boolean; txHash?: Hex };

/** A reserve's allowance, clock, balance, and policy as seen on-chain. */
export type ChainRead = { allowance: RawAllowance; nowSec: number; balance: bigint; executorIsMember: boolean; policyAsDesigned: boolean };

/** The mined receipt's outcome, or null while it cannot be confirmed. */
export type ReceiptResult = {
  status: "success" | "reverted";
  blockNumber: bigint;
  transactionHash: Hex;
  /**
   * The mined transaction's verified sender and nonce, attached only when the caller asked for the
   * transaction (`receipt`'s third flag) and it is consistent with the receipt: same hash, non-null
   * matching block hash, same sender. A pre-upgrade run carries no identity, so settlement needs
   * this proof to fence the executor's nonce correctly.
   */
  executorAddress?: Address;
  nonce?: number;
} | null;

/**
 * A signed repay transaction: `hash` is derived from `raw` alone and is known before any RPC can accept it
 * (BP-52). Broadcasting `raw` is idempotent — the same bytes always mean the same transaction.
 */
export type PreparedRepay = { raw: Hex; hash: Hex; nonce: number };

/** A role or allowance refusal decoded from the estimate; anything else is thrown, not returned. */
export type PrepareResult = { ok: true; tx: PreparedRepay } | { ok: false; error: string; name: string; detail: string | null };

export interface ReserveChain {
  read(link: ExecLink): Promise<ChainRead>;
  /** Whether the Reserve Safe executed the transaction with this hash since `fromBlock` (its `ExecutionSuccess` event). */
  wasExecuted(link: ExecLink, safeTxHash: Hex, fromBlock: bigint): Promise<boolean>;
  /** The chain's latest block number. */
  blockNumber(chainId: number): Promise<bigint>;
  /** The executor EOA's next nonce, including the mempool by default. */
  nonce(account: Pick<ExecLink, "chainId" | "executor">, tag?: "pending" | "finalized"): Promise<number>;
  /**
   * Build and sign the repay call under the caller-allocated `nonce`. Never sends anything. A role,
   * allowance or signer refusal is returned ({ok:false}); an RPC failure is thrown (transient).
   */
  prepare(link: ExecLink, amountRaw: bigint, nonce: number, signer: ExecutorSigner): Promise<PrepareResult>;
  /**
   * Broadcast an already-prepared transaction. Throws whenever acceptance cannot be confirmed — including
   * when the provider accepted it and the acknowledgement was lost — so the caller must treat a throw as
   * "unknown", never as "not sent". Resubmitting the same prepared transaction is safe.
   */
  submit(chainId: ChainId, tx: PreparedRepay): Promise<void>;
  /** A bounded wait for the mined receipt. Null when it cannot be confirmed within the wait. */
  waitReceipt(link: ExecLink, hash: Hex): Promise<ReceiptResult>;
  /**
   * The mined receipt's outcome for a broadcast hash, or null while it is not mined. May throw (RPC).
   * `withTransaction` also fetches the transaction and attaches its verified sender and nonce —
   * request it only when the run's stored identity is incomplete.
   */
  receipt(link: ExecLink, hash: Hex, withTransaction?: boolean): Promise<ReceiptResult>;
  /**
   * Request `amountRaw` through the role in one shot: allocate the pending nonce, prepare, submit, wait.
   * For callers that do not persist a durable handoff (tests); the executor goes through prepare/submit.
   */
  repay(link: ExecLink, amountRaw: bigint, signer: ExecutorSigner, onBroadcast?: (hash: Hex) => Promise<void> | void): Promise<RepayResult>;
}

const executionSuccess = parseAbiItem("event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)");

/** How long `waitReceipt` blocks before the run is left pending for the next reconcile. */
const RECEIPT_WAIT_MS = Number(process.env.RESERVE_RECEIPT_TIMEOUT_MS ?? 120_000);

const isSignerRefusal = (e: unknown) => e instanceof Error && (e.message.startsWith("The reserve key") || e.message.startsWith("The reserve call"));

export function createViemReserveChain(): ReserveChain {
  const chain: ReserveChain = {
    async read(link) {
      const s = await readReserveChain(getPublicClient(link.chainId), { chainId: link.chainId, reserve: link.reserveSafe, roles: link.roles, mainSafe: link.mainSafe, executor: link.executor, fromBlock: link.fromBlock });
      if (!s) throw new Error("The permission module is not on-chain yet.");
      return { allowance: s.allowance, nowSec: s.blockTimestamp, balance: s.balance, executorIsMember: s.executorIsMember, policyAsDesigned: policyAsDesigned(s) };
    },
    async wasExecuted(link, safeTxHash, fromBlock) {
      const logs = await getPublicClient(link.chainId).getLogs({ address: link.reserveSafe, event: executionSuccess, args: { txHash: safeTxHash }, fromBlock, toBlock: "latest" });
      return logs.length > 0;
    },
    async blockNumber(chainId) { return getPublicClient(chainId as 8453).getBlockNumber(); },
    async nonce(link, tag = "pending") {
      return getPublicClient(link.chainId).getTransactionCount({ address: link.executor, blockTag: tag });
    },
    async prepare(link, amountRaw, nonce, signer) {
      try {
        // Estimating gas runs the call, so a role or allowance refusal surfaces here and nothing is sent.
        const p = await prepareRoleCall(getPublicClient(link.chainId), signer, buildRoleRepay({ chainId: link.chainId, roles: link.roles, mainSafe: link.mainSafe, amount: amountRaw }), nonce);
        return { ok: true, tx: { raw: p.raw, hash: p.hash, nonce } };
      } catch (e) {
        const f = decodeRolesFailure(e);
        // A decoded Roles revert and a signer refusal are terminal "the chain says no". Anything else
        // (RPC down, gas-oracle failure) is thrown: the claimed run stays resumable instead of failing.
        if (f.name === "Unknown" && !isSignerRefusal(e)) throw e;
        return { ok: false, error: f.message, name: f.name, detail: f.detail };
      }
    },
    async submit(chainId, tx) {
      const sent = await submitSignedRoleCall(getPublicClient(chainId), tx.raw);
      if (sent.toLowerCase() !== tx.hash.toLowerCase()) throw new Error(`broadcast returned ${sent} but the prepared transaction is ${tx.hash}`);
    },
    async waitReceipt(link, hash) {
      try {
        const r = await getPublicClient(link.chainId).waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS, checkReplacement: false });
        return { status: r.status === "success" ? "success" : "reverted", blockNumber: r.blockNumber, transactionHash: r.transactionHash };
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (name === "WaitForTransactionReceiptTimeoutError" || name === "TransactionReceiptNotFoundError") return null;
        throw e;
      }
    },
    async receipt(link, hash, withTransaction) {
      const client = getPublicClient(link.chainId);
      try {
        const r = await client.getTransactionReceipt({ hash });
        const result: NonNullable<ReceiptResult> = { status: r.status === "success" ? "success" : "reverted", blockNumber: r.blockNumber, transactionHash: r.transactionHash };
        if (withTransaction && r.transactionHash.toLowerCase() === hash.toLowerCase()) {
          const tx = await client.getTransaction({ hash: r.transactionHash }).catch((e: unknown) => {
            if (e instanceof Error && e.name === "TransactionNotFoundError") return null;
            throw e;
          });
          // Attach the identity only when the fetched transaction provably is the receipt's: same
          // hash, a non-null block hash equal to the receipt's, and the same sender.
          if (tx && tx.hash.toLowerCase() === r.transactionHash.toLowerCase() && tx.blockHash !== null && tx.blockHash === r.blockHash
            && tx.from.toLowerCase() === r.from.toLowerCase()) {
            result.executorAddress = tx.from.toLowerCase() as Address;
            result.nonce = tx.nonce;
          }
        }
        return result;
      } catch (e) {
        if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") return null;
        throw e;
      }
    },
    async repay(link, amountRaw, signer, onBroadcast) {
      let sent: Hex | undefined;
      try {
        const nonce = await chain.nonce(link);
        const p = await chain.prepare(link, amountRaw, nonce, signer);
        if (!p.ok) return { ok: false, error: p.error, name: p.name, detail: p.detail };
        sent = p.tx.hash;
        await chain.submit(link.chainId, p.tx);
        await onBroadcast?.(sent);
        const receipt = await chain.waitReceipt(link, sent);
        if (!receipt || receipt.transactionHash.toLowerCase() !== sent.toLowerCase()) return { ok: false, pending: true, txHash: sent, error: "the original transaction receipt could not be confirmed", name: "ReceiptUnknown", detail: null };
        if (receipt.status !== "success") return { ok: false, error: "The repay transaction reverted on-chain.", name: "Reverted", detail: null };
        return { ok: true, txHash: sent, blockNumber: receipt.blockNumber };
      } catch (e) {
        // Once broadcast, an error is not "nothing moved": the hash is returned so the next tick can read the receipt.
        if (sent) return { ok: false, pending: true, txHash: sent, error: "The network did not confirm the repay.", name: "ReceiptUnknown", detail: null };
        const f = decodeRolesFailure(e);
        return { ok: false, error: f.message, name: f.name, detail: f.detail };
      }
    },
  };
  return chain;
}
