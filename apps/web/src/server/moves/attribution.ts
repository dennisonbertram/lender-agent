// The deposit job must not announce a move's arrival as a deposit (BP-31 meets BP-38). Like the executed-proposal attribution
// in deposits/poll.ts, but per asset and network: a balance rise of a moving asset on the move's destination (or, after a refund,
// on its source) is the move's, but only up to what is PROVEN to have come from the move: the amount its destination transaction
// paid the Safe (the arrival proof, the same check the move job uses). While a move is still pending and unproven, a rise of the
// same asset is not its: it is an ordinary deposit and consumes nothing of the move.
import { and, eq, gte, or } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { moves } from "@/server/db/schema";
import type { Rise } from "@/server/deposits/detect";
import { getAddress } from "viem";
import type { Address, Hex } from "@/shared/types";
import { followTransfer, type DestinationChain } from "./arrival";
import { quoteFromJson, type BridgeAggregator, type MoveChain } from "./types";

/** What it takes to prove a pending move's arrival; without it a pending move explains nothing. */
export type ArrivalProof = { aggregator: BridgeAggregator; destination: DestinationChain };

/** How long after an arrival or refund the deposit job may still see the rise (a slow poll). */
export const ATTRIBUTION_WINDOW_MS = 30 * 60_000;

export async function attributeToMoves(db: Db, safeId: number, chainId: number, rises: readonly Rise[], now: Date, proof?: ArrivalProof, safeAddress?: string): Promise<Rise[]> {
  if (rises.length === 0) return [];
  const since = new Date(now.getTime() - ATTRIBUTION_WINDOW_MS);
  const open = await db.select().from(moves).where(and(eq(moves.safeId, safeId), or(
    and(eq(moves.toChain, chainId), eq(moves.status, "bridging")),
    and(eq(moves.toChain, chainId), eq(moves.status, "arrived"), gte(moves.arrivedAt, since)),
    and(eq(moves.fromChain, chainId), eq(moves.status, "refunded"), gte(moves.arrivedAt, since)),
  ))).orderBy(moves.createdAt);
  const left = rises.map((r) => ({ ...r }));
  for (const m of open) {
    const q = quoteFromJson(m.quote);
    // What the move may still explain: on arrival the amount that arrived; while bridging only what its destination transaction is proven to have paid; after a refund what was sent.
    let cap: bigint;
    if (m.status === "arrived") cap = BigInt(m.receivedRaw ?? 0);
    else if (m.status === "refunded") cap = q.fromAmount;
    else cap = await provenArrival(proof, m, q.toToken, safeAddress);
    let remaining = cap - BigInt(m.attributedRaw);
    for (const r of left) {
      if (remaining <= 0n) break;
      if (r.asset !== m.asset || r.raw <= 0n) continue;
      const take = r.raw < remaining ? r.raw : remaining;
      r.raw -= take;
      remaining -= take;
      await db.update(moves).set({ attributedRaw: (cap - remaining).toString() }).where(eq(moves.id, m.id));
    }
  }
  return left.filter((r) => r.raw > 0n);
}

/** The amount the move's destination transaction paid the Safe, or 0 while the bridge has not proven it. */
async function provenArrival(proof: ArrivalProof | undefined, m: typeof moves.$inferSelect, token: Address, safeAddress: string | undefined): Promise<bigint> {
  if (!proof || !safeAddress || !m.sourceTxHash || !m.sentAt) return 0n;
  try {
    const o = await followTransfer({ aggregator: proof.aggregator, chain: proof.destination }, { safe: getAddress(safeAddress) as Address, fromChain: m.fromChain as MoveChain, toChain: m.toChain as MoveChain, sourceTxHash: m.sourceTxHash as Hex, token, durationSec: 0, sentAt: m.sentAt.getTime() }, new Date());
    return o.kind === "arrived" ? o.amountRaw : 0n;
  } catch {
    return 0n; // cannot prove it: not the move's
  }
}
