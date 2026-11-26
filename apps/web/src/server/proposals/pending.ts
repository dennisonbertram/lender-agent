// The "I sent the execution" marker. The Transaction Service indexes an execution late, so right
// after the owner's wallet sends it the nonce has moved but the service still says "not executed".
// The marker keeps `checkStale` from calling that proposal out of date during a grace period. It is a
// hint, never proof: the follower still settles executed/failed from the service and the receipt.
import type { Hex } from "@/shared/types";

export const PENDING_EXEC_GRACE_MS = 30 * 60 * 1000;

/** A hash the node did not know when it was reported is believed for less time: it may be a typo or a dropped transaction. */
export const PENDING_UNKNOWN_GRACE_MS = 5 * 60 * 1000;

export type PendingExec = { txHash: Hex; at: string; by: string; /** The node knew the transaction when it was reported. */ known?: boolean };

export const pendingGraceOf = (p: PendingExec) => (p.known ? PENDING_EXEC_GRACE_MS : PENDING_UNKNOWN_GRACE_MS);

export function pendingExecOf(testRun: unknown, now: number = Date.now()): PendingExec | null {
  const p = (testRun as { pendingExec?: PendingExec } | null)?.pendingExec;
  if (!p || typeof p.txHash !== "string" || typeof p.at !== "string") return null;
  const at = Date.parse(p.at);
  return Number.isNaN(at) || now - at >= pendingGraceOf(p) ? null : p;
}
