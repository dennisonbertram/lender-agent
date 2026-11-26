// Arrival (BP-38, architecture 3.3 and section 4): the bridge's status for THIS transfer says done and complete, and the
// destination transaction it names is confirmed on-chain and pays the Safe. A balance change alone is never proof (other deposits
// and spends happen), so nothing here reads a balance without the transfer's own status.
import type { Address, Hex } from "@/shared/types";
import type { BridgeAggregator, MoveChain } from "./types";

/** Something confirmed on a network the rest of the app does not read. */
export interface DestinationChain {
  hasCode(chainId: MoveChain, address: Address): Promise<boolean>;
  /**
   * The Safe's owners on that network (`getOwners`), or null when they cannot be verified: no Safe there, the code
   * is not a canonical Safe proxy on a canonical singleton (a contract that merely answers getOwners is not), or the read failed.
   */
  ownersOf(chainId: MoveChain, address: Address): Promise<Address[] | null>;
  /** Did this transaction succeed and pay the Safe (the token, or native when `token` is the zero address)? `amountRaw` is what it paid. */
  paysSafe(p: { chainId: MoveChain; txHash: Hex; safe: Address; token: Address; minRaw?: bigint }): Promise<{ ok: true; amountRaw: bigint } | { ok: false; reason: string }>;
}

/** After the quoted time, how much longer before the agent says the move is delayed. */
export const MOVE_DELAY_MARGIN_MS = 10 * 60_000;

export type TrackedMove = { safe: Address; fromChain: MoveChain; toChain: MoveChain; sourceTxHash: Hex; token: Address; durationSec: number; sentAt: number; expectedRaw?: bigint };

export type Outcome =
  | { kind: "pending" }
  /** Not arrived after the quoted time plus a margin. Not a failure: the bridge may just be slow or not indexed yet. */
  | { kind: "delayed" }
  | { kind: "arrived"; amountRaw: bigint; destTxHash: Hex }
  /** The bridge says done, but the destination transaction is not (yet) confirmed as paying the Safe. */
  | { kind: "unconfirmed"; reason: string }
  | { kind: "partial"; message?: string }
  | { kind: "refunded"; message?: string }
  | { kind: "failed"; message?: string };

export async function followTransfer(deps: { aggregator: BridgeAggregator; chain: DestinationChain }, m: TrackedMove, now: Date): Promise<Outcome> {
  let status;
  try {
    status = await deps.aggregator.status({ txHash: m.sourceTxHash, fromChain: m.fromChain, toChain: m.toChain });
  } catch {
    status = { state: "pending" as const }; // an outage is not a verdict
  }
  switch (status.state) {
    case "failed":
      return { kind: "failed", ...(status.message ? { message: status.message } : {}) };
    case "done": {
      if (status.sub === "PARTIAL") return { kind: "partial", ...(status.message ? { message: status.message } : {}) };
      if (status.sub === "REFUNDED") return { kind: "refunded", ...(status.message ? { message: status.message } : {}) };
      if (status.sub !== "COMPLETED") return { kind: "unconfirmed", reason: `the bridge reports ${status.sub ?? "done"} without saying it is complete` };
      const r = status.receiving;
      if (!r || r.chainId !== m.toChain) return { kind: "unconfirmed", reason: "the bridge names no destination transaction on the destination network" };
      const paid = await deps.chain.paysSafe({ chainId: m.toChain, txHash: r.txHash, safe: m.safe, token: m.token, minRaw: 1n });
      return paid.ok ? { kind: "arrived", amountRaw: paid.amountRaw, destTxHash: r.txHash } : { kind: "unconfirmed", reason: paid.reason };
    }
    default:
      return now.getTime() >= m.sentAt + m.durationSec * 1000 + MOVE_DELAY_MARGIN_MS ? { kind: "delayed" } : { kind: "pending" };
  }
}
