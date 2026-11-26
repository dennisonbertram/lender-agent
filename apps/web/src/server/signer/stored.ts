// What the signer may sign: only a stored proposal (architecture section 2, rule 3). The caller names
// a proposal id; everything signed is read back from that record, never taken from the caller.
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import type { Db } from "@/server/db/client";
import { proposals, safes } from "@/server/db/schema";
import type { PrivateKeyAccount } from "viem/accounts";
import { deleteRequestTypedData, safeTxHash as computeSafeTxHash, safeTxTypedData } from "../safe/hash";
import type { Address, ChainId, Hex, SafeTx } from "@/shared/types";

export class SignerRefusal extends Error {}

/** A proposal may be signed while it is being sent. */
const SIGNABLE_STAGES = ["sending"];
/** A DeleteRequest only makes sense for a proposal that is in the Safe queue. */
// "sending": an earlier build may have reached the service before its response was lost. "stopped"
// remains deletable only while deletedFromQueue is false and the stored transaction still hashes to
// the stored Safe hash; this is the post-lock cleanup state for agent removal.
const DELETABLE_STAGES = ["sending", "queued", "stale", "stopped"];

async function load(db: Db, p: { proposalId: string; chainId: ChainId; safe: Address }) {
  const [row] = await db.select({ p: proposals, safeAddress: safes.address })
    .from(proposals).innerJoin(safes, eq(safes.id, proposals.safeId)).where(eq(proposals.id, p.proposalId)).limit(1);
  if (!row) throw new SignerRefusal(`Unknown proposal "${p.proposalId}"; nothing to sign.`);
  if (row.p.chainId !== p.chainId) throw new SignerRefusal("The proposal is on a different network; refusing to sign.");
  if (getAddress(row.safeAddress) !== getAddress(p.safe)) throw new SignerRefusal("The proposal belongs to a different Safe; refusing to sign.");
  return row.p;
}

/** The stored transaction and its hash, for a proposal in a signable stage on this Safe and network. */
export async function loadSignableProposal(db: Db, p: { proposalId: string; chainId: ChainId; safe: Address }): Promise<{ tx: SafeTx; safeTxHash: Hex }> {
  const row = await load(db, p);
  if (!SIGNABLE_STAGES.includes(row.stage)) throw new SignerRefusal(`A proposal in stage "${row.stage}" cannot be signed.`);
  if (!row.tx || !row.safeTxHash) throw new SignerRefusal("The proposal has no stored transaction; nothing to sign.");
  const tx = row.tx as SafeTx;
  const hash = computeSafeTxHash(p.chainId, p.safe, tx);
  if (hash.toLowerCase() !== row.safeTxHash.toLowerCase()) throw new SignerRefusal("The stored transaction does not match its stored hash; refusing to sign.");
  return { tx, safeTxHash: hash };
}

/**
 * The stored transaction and hash for an OWNER to sign or execute: a queued proposal on this Safe and network.
 * The agent signer never uses this (its list stays `sending` only); the owner signs in their own wallet.
 */
export async function loadOwnerSignable(db: Db, p: { proposalId: string; chainId: ChainId; safe: Address }) {
  const row = await load(db, p);
  if (row.stage !== "queued") throw new SignerRefusal(`A proposal in stage "${row.stage}" cannot be signed by an owner.`);
  if (!row.tx || !row.safeTxHash) throw new SignerRefusal("The proposal has no stored transaction; nothing to sign.");
  const tx = row.tx as SafeTx;
  const hash = computeSafeTxHash(p.chainId, p.safe, tx);
  if (hash.toLowerCase() !== row.safeTxHash.toLowerCase()) throw new SignerRefusal("The stored transaction does not match its stored hash; refusing to sign.");
  return { tx, safeTxHash: hash, row };
}

/** The stored hash to delete, for a queued proposal with no owner confirmations (M0-3: the service would delete a confirmed one anyway). */
export async function loadDeletableProposal(db: Db, p: { proposalId: string; chainId: ChainId; safe: Address }): Promise<{ safeTxHash: Hex }> {
  const row = await load(db, p);
  if (!DELETABLE_STAGES.includes(row.stage) || (row.stage === "stopped" && row.deletedFromQueue)) {
    throw new SignerRefusal(`A proposal in stage "${row.stage}" cannot be deleted from the queue.`);
  }
  if (!row.safeTxHash || !row.tx) throw new SignerRefusal("The proposal has no stored transaction; nothing to delete.");
  const hash = computeSafeTxHash(p.chainId, p.safe, row.tx as SafeTx);
  if (hash.toLowerCase() !== row.safeTxHash.toLowerCase()) throw new SignerRefusal("The stored transaction does not match its stored hash; refusing to sign a delete.");
  if (row.confirmations.length > 0) throw new SignerRefusal("An owner already confirmed this proposal; refusing to sign a delete.");
  return { safeTxHash: hash };
}

/** Sign a stored proposal (EIP-712 over the recomputed Safe transaction). Shared by every key-holding signer. */
export async function signStoredProposal(account: PrivateKeyAccount, db: Db, p: { proposalId: string; chainId: ChainId; safe: Address }) {
  const { tx, safeTxHash } = await loadSignableProposal(db, p);
  const signature = await account.signTypedData(safeTxTypedData(p.chainId, p.safe, tx));
  return { safeTxHash, signature };
}

/** Sign the Transaction Service DeleteRequest for a stored, deletable proposal. */
export async function signStoredDeleteRequest(account: PrivateKeyAccount, db: Db, p: { proposalId: string; chainId: ChainId; safe: Address; totp: number }) {
  const { safeTxHash } = await loadDeletableProposal(db, p);
  return account.signTypedData(deleteRequestTypedData(p.chainId, p.safe, safeTxHash, p.totp));
}
