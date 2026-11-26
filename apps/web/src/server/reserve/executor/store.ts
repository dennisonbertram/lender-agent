import { and, eq, isNotNull, isNull, lte, not, or } from "drizzle-orm";
import { getAddress } from "viem";
import type { Db } from "@/server/db/client";
import { reserveLinks, reservePolicyChanges, reserveRuns, safeNetworks, safes } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import type { Address, ChainId } from "@/shared/types";
import { OFF_REPAY_PENDING } from "../policy-change/copy";
import { RESERVE_ASSET } from "../constants";
import type { ExecLink } from "../types";
import { clearReserveCache } from "../status";

/** The linked Reserve for a Safe on a network (the canonical `reserve_links` row), or null. */
export async function loadReserveLink(db: Db, safeId: number, chainId: ChainId): Promise<ExecLink | null> {
  const [r] = await db.select({ l: reserveLinks }).from(reserveLinks)
    .where(and(eq(reserveLinks.mainSafeId, safeId), eq(reserveLinks.chainId, chainId))).limit(1);
  const a = RESERVE_ASSET[chainId];
  if (!r || !a) return null;
  const [main] = await db.select().from(safes).where(eq(safes.id, safeId)).limit(1);
  const [reserve] = await db.select().from(safes).where(eq(safes.id, r.l.reserveSafeId)).limit(1);
  if (!main || !reserve) return null;
  return linkFromRow(safeId, chainId, r.l, main.address, reserve.address);
}

/**
 * Build an `ExecLink` from a `reserve_links` row plus the two Safes' addresses. Under the link row
 * lock this is the generation the gate prepares against — `attempt` makes a re-link detectable.
 */
export function linkFromRow(
  safeId: number, chainId: ChainId,
  row: Pick<typeof reserveLinks.$inferSelect, "attempt" | "rolesAddress" | "executorAddress" | "triggerHf" | "state" | "fromBlock">,
  mainSafe: string, reserveSafe: string,
): ExecLink {
  const a = RESERVE_ASSET[chainId];
  if (!a) throw new Error(`The reserve asset is not configured for chain ${chainId}`);
  return {
    safeId, chainId, mainSafe: getAddress(mainSafe) as Address, reserveSafe: getAddress(reserveSafe) as Address,
    roles: getAddress(row.rolesAddress) as Address, executor: getAddress(row.executorAddress) as Address,
    token: a.usdc, tokenSymbol: a.symbol, tokenDecimals: a.decimals,
    trigger: row.triggerHf, attempt: row.attempt, active: row.state !== "off" && row.state !== "relinking", fromBlock: row.fromBlock,
  };
}

/**
 * The link generation a run is claimed under: `attempt|reserveSafe|roles|executor`, lowercased.
 * The gate recomputes it under the row lock and refuses a handoff on mismatch — a re-link (which
 * bumps `attempt`, or swaps any of these addresses) can never let a stale prepared request spend.
 */
export const linkFingerprint = (link: Pick<ExecLink, "attempt" | "reserveSafe" | "roles" | "executor">): string =>
  [link.attempt, link.reserveSafe, link.roles, link.executor].join("|").toLowerCase();

/** Apply the trigger after the signed policy change executes. */
export async function setReserveTrigger(db: Db, safeId: number, chainId: ChainId, triggerHf: number): Promise<void> {
  await db.update(reserveLinks).set({
    triggerHf,
    updatedAt: new Date(),
  }).where(and(eq(reserveLinks.mainSafeId, safeId), eq(reserveLinks.chainId, chainId)));
  clearReserveCache(); // the page, sidebar and chat header must not keep showing the old state
}

/** The transaction handle a `db.transaction` callback gets. */
export type ReserveTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The canonical `reserve_links` row under `SELECT ... FOR UPDATE`: what serializes turn-off against a broadcast, in every process. */
async function lockLinkRow(tx: ReserveTx, safeId: number, chainId: ChainId) {
  const [row] = await tx.select().from(reserveLinks)
    .where(and(eq(reserveLinks.mainSafeId, safeId), eq(reserveLinks.chainId, chainId))).limit(1).for("update");
  return row;
}

async function stopLockedReserve(tx: ReserveTx, row: typeof reserveLinks.$inferSelect | undefined): Promise<boolean> {
  if (!row) return false;
  if (row.state === "relinking") throw new HttpError(409, "A Reserve setup is being prepared. Refresh before turning it off.");
  const pending = and(eq(reserveRuns.safeId, row.mainSafeId), eq(reserveRuns.chainId, row.chainId), eq(reserveRuns.status, "pending"));
  const [inFlight] = await tx.select({ id: reserveRuns.id }).from(reserveRuns)
    .where(and(pending, not(or(unsignedClaimFields, signedBeforeIntentFields)!))).limit(1);
  if (inFlight) throw new HttpError(409, OFF_REPAY_PENDING);
  await tx.update(reserveRuns).set({ ...releasedHandoffFields, error: "The reserve was turned off before submission intent committed." })
    .where(and(pending, signedBeforeIntentFields));
  if (row.state !== "off") await tx.update(reserveLinks).set({ state: "off", updatedAt: new Date() }).where(eq(reserveLinks.id, row.id));
  return row.state !== "off";
}

/** Serialize signing, committing intent, sending, and turn-off on the canonical link row. */
export async function withReserveLinkLock<T>(db: Db, safeId: number, chainId: ChainId, fn: (tx: ReserveTx, row: typeof reserveLinks.$inferSelect | undefined) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const row = await lockLinkRow(tx, safeId, chainId);
    return fn(tx, row);
  });
}

/** Only these fields together prove a pending row predates the durable handoff. */
export const unsignedClaimFields = and(
  isNotNull(reserveRuns.leaseExpiresAt), isNull(reserveRuns.signedTx), isNull(reserveRuns.txHash),
  isNull(reserveRuns.nonce), isNull(reserveRuns.executorAddress), isNull(reserveRuns.broadcastAt),
)!;

const signedBeforeIntentFields = and(
  isNotNull(reserveRuns.leaseExpiresAt), isNotNull(reserveRuns.signedTx), isNotNull(reserveRuns.txHash),
  isNotNull(reserveRuns.nonce), isNotNull(reserveRuns.executorAddress), isNull(reserveRuns.broadcastAt),
)!;

export const expiredSignedHandoff = (now: Date) =>
  and(signedBeforeIntentFields, lte(reserveRuns.leaseExpiresAt, now));

export const releasedHandoffFields = {
  status: "failed", txHash: null, signedTx: null, nonce: null, executorAddress: null,
  broadcastAt: null, leaseExpiresAt: null,
} as const;

/** Release a signed nonce after agent removal only while the lease is expired and intent is absent. */
export async function releaseExpiredUnwatchedHandoff(db: Db, safeId: number, chainId: ChainId, runId: number, now: Date): Promise<void> {
  await withReserveLinkLock(db, safeId, chainId, async (tx, link) => {
    if (!link) return;
    const releasable = and(
      eq(reserveRuns.id, runId), eq(reserveRuns.safeId, safeId), eq(reserveRuns.chainId, chainId),
      eq(reserveRuns.status, "pending"), expiredSignedHandoff(now),
    );
    // Submission takes the same locks in this order. If intent already committed, the row no longer matches.
    const [run] = await tx.select({ id: reserveRuns.id }).from(reserveRuns).where(releasable).for("update");
    if (!run) return;
    const [network] = await tx.select({ agentAdded: safeNetworks.agentAdded }).from(safeNetworks)
      .where(and(eq(safeNetworks.safeId, safeId), eq(safeNetworks.chainId, chainId))).for("update");
    if (network?.agentAdded !== false) return;
    await tx.update(reserveRuns).set({
      ...releasedHandoffFields, error: "The Lender agent was removed before reserve submission intent committed.",
    }).where(releasable);
  });
}

/** Stop staged work before intent. A committed or ambiguous broadcast requires settlement first. */
export async function stopReserve(db: Db, safeId: number, chainId: ChainId): Promise<boolean> {
  const wasActive = await withReserveLinkLock(db, safeId, chainId, async (tx, row) => {
    return stopLockedReserve(tx, row);
  });
  clearReserveCache(); // after commit: the page, sidebar and chat header must not keep showing the old state
  return wasActive;
}

/** Apply a confirmed revocation only to the link generation that was read before the chain check. */
export async function applyReserveRevocation(db: Db, safeId: number, chainId: ChainId, changeId: string, expectedAttempt: number, appliedAt: Date): Promise<boolean> {
  const applied = await withReserveLinkLock(db, safeId, chainId, async (tx, row) => {
    if (!row || row.attempt !== expectedAttempt) return false;
    const [change] = await tx.select({ id: reservePolicyChanges.id }).from(reservePolicyChanges)
      .where(and(eq(reservePolicyChanges.id, changeId), eq(reservePolicyChanges.safeId, safeId), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off"), eq(reservePolicyChanges.status, "pending")))
      .limit(1).for("update");
    if (!change) return false;
    await stopLockedReserve(tx, row);
    const [updated] = await tx.update(reservePolicyChanges).set({ status: "applied", appliedAt })
      .where(and(eq(reservePolicyChanges.id, changeId), eq(reservePolicyChanges.status, "pending"))).returning({ id: reservePolicyChanges.id });
    return !!updated;
  });
  if (applied) clearReserveCache();
  return applied;
}
