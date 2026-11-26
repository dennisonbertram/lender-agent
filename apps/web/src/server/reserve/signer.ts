// The reserve executor key (architecture 2 rule 6): a separate Signer from the proposer, a member of the
// one Roles role on the Reserve Safe. Its only operation signs a transaction that calls
// `execTransactionWithRole` on a Roles modifier; nothing else can be signed. Dev: an anvil key. KMS: stub.
import { decodeFunctionData, getAddress, keccak256, type Hex, type PublicClient, type TransactionReceipt, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "@/shared/types";
import { ANVIL_DEV_KEYS } from "@/server/signer/dev";
import { rolesAbi } from "./roles-abi";

export interface ExecutorSigner {
  address: Address;
  /** Sign one EIP-1559 transaction. Refused unless it is `execTransactionWithRole` with no value and no delegatecall. */
  signRoleCall(tx: TransactionSerializableEIP1559): Promise<Hex>;
}

/** What may be signed: `execTransactionWithRole(to, 0, data, operation 0, role, shouldRevert)` and nothing else. */
export function assertRoleCall(tx: { data?: Hex; value?: bigint }): void {
  if (tx.value && tx.value > 0n) throw new Error("The reserve key never sends ETH.");
  let decoded;
  try { decoded = decodeFunctionData({ abi: rolesAbi, data: tx.data ?? "0x" }); } catch { throw new Error("The reserve key only signs execTransactionWithRole."); }
  if (decoded.functionName !== "execTransactionWithRole") throw new Error("The reserve key only signs execTransactionWithRole.");
  const [, value, , operation, , shouldRevert] = decoded.args as readonly [Address, bigint, Hex, number, Hex, boolean];
  if (value !== 0n || operation !== 0) throw new Error("The reserve key never sends ETH or delegates.");
  if (!shouldRevert) throw new Error("The reserve call must revert on failure (shouldRevert).");
}

export class DevExecutorSigner implements ExecutorSigner {
  private readonly account;
  readonly address: Address;
  constructor(key: Hex | undefined) {
    if (!key) throw new Error("DEV_EXECUTOR_KEY is not set");
    if (!ANVIL_DEV_KEYS.includes(key.toLowerCase() as Hex)) throw new Error("DEV_EXECUTOR_KEY must be one of anvil's well-known keys; refusing to use any other key");
    this.account = privateKeyToAccount(key);
    this.address = this.account.address;
  }
  async signRoleCall(tx: TransactionSerializableEIP1559) {
    assertRoleCall(tx);
    return this.account.signTransaction(tx);
  }
}

/** Production stub: the KMS key is not wired yet. */
export class KmsExecutorSigner implements ExecutorSigner {
  get address(): Address { throw new Error("Reserve KMS signer not configured"); }
  async signRoleCall(_tx: TransactionSerializableEIP1559): Promise<Hex> { throw new Error("Reserve KMS signer not configured"); }
}

/** `EXECUTOR_SIGNER` is `dev` (default, `DEV_EXECUTOR_KEY`) or `kms`. The key must differ from the proposer's key (`DEV_PROPOSER_KEY`). */
export function getExecutorSigner(env: Record<string, string | undefined> = process.env): ExecutorSigner {
  const kind = env.EXECUTOR_SIGNER ?? "dev";
  if (kind === "kms") return new KmsExecutorSigner();
  if (kind !== "dev") throw new Error(`Unknown EXECUTOR_SIGNER "${kind}" (expected dev or kms)`);
  if (env.DEV_EXECUTOR_KEY && env.DEV_PROPOSER_KEY && env.DEV_EXECUTOR_KEY.toLowerCase() === env.DEV_PROPOSER_KEY.toLowerCase()) {
    throw new Error("The reserve executor key must not be the proposer key.");
  }
  return new DevExecutorSigner(env.DEV_EXECUTOR_KEY as Hex | undefined);
}

/**
 * A fully signed role call ready to submit: `hash` is the deterministic `keccak256(raw)`, known before
 * any RPC can see the transaction, so the caller can durably persist it first (BP-52). Resubmitting
 * `raw` is idempotent: the same bytes always produce the same hash and the same on-chain effect.
 */
export type PreparedRoleCall = {
  /** The signed EIP-1559 transaction body (what `signRoleCall` restricted). */
  tx: TransactionSerializableEIP1559;
  /** The serialized signed transaction to hand to `sendRawTransaction`. */
  raw: Hex;
  /** The transaction hash derived from `raw` alone — valid before submission. */
  hash: Hex;
};

/**
 * Estimate fees/gas and sign one role call under the caller-supplied `nonce`. The nonce is allocated
 * by the caller under the executor key's DB-backed lock, so different reserves on one chain can never
 * claim the same nonce. Nothing is submitted here: the returned `raw`/`hash` are persisted first.
 */
export async function prepareRoleCall(client: PublicClient, signer: ExecutorSigner, call: { to: Address; data: Hex }, nonce: number): Promise<PreparedRoleCall> {
  const from = getAddress(signer.address);
  const [fees, chainId] = await Promise.all([client.estimateFeesPerGas(), client.getChainId()]);
  const gas = (await client.estimateGas({ account: from, to: call.to, data: call.data })) * 12n / 10n;
  const tx: TransactionSerializableEIP1559 = { type: "eip1559", chainId, nonce, to: call.to, data: call.data, value: 0n, gas, maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas! };
  const raw = await signer.signRoleCall(tx);
  return { tx, raw, hash: keccak256(raw) };
}

/** Keep the signed request in its own viem HTTP batch, whose errors can contain the full request body. */
export async function submitSignedRoleCall(client: PublicClient, raw: Hex): Promise<Hex> {
  try {
    return await client.request({ method: "eth_sendRawTransaction", params: [raw] }, {
      retryCount: 0,
      signal: new AbortController().signal,
    });
  } catch {
    throw new Error("The network did not confirm the reserve submission.");
  }
}

/**
 * Send one role call as the executor and wait for its receipt. The caller reads the receipt before it
 * reports anything as done (BP-41). A revert on-chain returns status "reverted"; it is never hidden.
 * Composed from `prepareRoleCall` for callers that do not need a durable handoff (tests).
 */
export async function sendRoleCall(client: PublicClient, signer: ExecutorSigner, call: { to: Address; data: Hex }, onBroadcast?: (hash: Hex) => Promise<void> | void): Promise<TransactionReceipt> {
  const nonce = await client.getTransactionCount({ address: getAddress(signer.address), blockTag: "pending" });
  const { raw } = await prepareRoleCall(client, signer, call, nonce);
  const sent = await submitSignedRoleCall(client, raw);
  await onBroadcast?.(sent); // the hash is kept before anything else can fail
  const receipt = await client.waitForTransactionReceipt({ hash: sent, checkReplacement: false });
  if (receipt.transactionHash.toLowerCase() !== sent.toLowerCase()) throw new Error("The network did not return the reserve transaction's receipt.");
  return receipt;
}

