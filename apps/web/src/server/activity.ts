// The only writer of the `activity` table (BP-27, rule G3). Append-only: there is no update or
// delete function, on purpose. Every agent read, proposal, status change and signature calls this.
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { activity } from "@/server/db/schema";
import type { Actor, ActivityKind, Address, ChainId } from "@/shared/types";

export type ActivityInput = {
  safeId: number;
  chainId?: ChainId | null;
  actor: Actor;
  /** For "You" / "Co-signer": the signing owner from the Transaction Service, never invented. */
  actorAddress?: Address | null;
  kind: ActivityKind;
  text: string;
  detail?: string | null;
  proposalId?: string | null;
  /** Idempotency: a poll that observes the same event twice writes one row. */
  eventKey?: string | null;
  /** On-chain transaction hash and Safe transaction hash; kept only as 0x + 64 hex, lowercased. */
  txHash?: string | null;
  safeTxHash?: string | null;
  at?: Date;
};

const HASH = /^0x[0-9a-fA-F]{64}$/;
const cleanHash = (h?: string | null): string | null => (h && HASH.test(h) ? h.toLowerCase() : null);

export type ActivityRow = typeof activity.$inferSelect;

/** Append one row. With an `eventKey` that already exists, nothing is written and null is returned. */
export async function recordActivity(db: Db, input: ActivityInput): Promise<ActivityRow | null> {
  const rows = await db
    .insert(activity)
    .values({
      safeId: input.safeId,
      chainId: input.chainId ?? null,
      actor: input.actor,
      actorAddress: input.actorAddress?.toLowerCase() ?? null,
      kind: input.kind,
      text: input.text,
      detail: input.detail ?? null,
      proposalId: input.proposalId ?? null,
      eventKey: input.eventKey ?? null,
      txHash: cleanHash(input.txHash),
      safeTxHash: cleanHash(input.safeTxHash),
      ...(input.at ? { at: input.at } : {}),
    })
    .onConflictDoNothing({ target: activity.eventKey })
    .returning();
  return rows[0] ?? null;
}

/** Rows for one Safe, newest first. Callers filter by the networks the wallet owns (G4). */
export async function listActivity(db: Db, safeId: number, order: "newest" | "oldest" = "newest"): Promise<ActivityRow[]> {
  return db
    .select()
    .from(activity)
    .where(eq(activity.safeId, safeId))
    .orderBy(order === "newest" ? desc(activity.at) : asc(activity.at), order === "newest" ? desc(activity.id) : asc(activity.id));
}
