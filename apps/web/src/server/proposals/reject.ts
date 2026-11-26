// Reject a proposal (BP-16, architecture 2 rule 3 and 8.2). Only an unconfirmed queued proposal is
// deleted from the Safe queue, and we check `confirmations` ourselves: the hosted service deletes a
// confirmed one too (M0-3). A confirmed one, or a refused delete, stays in the queue and the card
// says so. Never called "cancelled": only an executed transaction with that nonce settles it.
import { and, eq, inArray } from "drizzle-orm";
import { getAddress } from "viem";
import { recordActivity } from "@/server/activity";
import { proposals } from "@/server/db/schema";
import { requireNetwork } from "@/server/auth/access";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import { currentTotp } from "@/server/safe/hash";
import type { ChainId, Hex } from "@/shared/types";
import { proposalView, type ProposalView } from "./view";

const REJECTABLE = ["draft", "queued", "stale"];
const lc = (a: string) => a.toLowerCase();

/** Delete only a visible proposal with no known confirmations. A missing service row is not proof
 * that signatures were never collected, so it is reported as absent but not safely deletable. */
async function deleteIfUnconfirmedResult(ctx: Pick<SafeContext, "services">, proposalId: string, chainId: ChainId, safeTxHash: Hex, ownConfirmed: boolean): Promise<{ deleted: boolean; confirmedUnsignedDeletion: boolean }> {
  const { services } = ctx;
  const service = services.safeService(chainId);
  try {
    const live = await service.getMultisigTransaction(safeTxHash);
    if (!live) return { deleted: true, confirmedUnsignedDeletion: false };
    if (live.isExecuted) throw new HttpError(409, "This already ran in Safe, so it cannot be rejected.");
    if (ownConfirmed || live.confirmations.length > 0) return { deleted: false, confirmedUnsignedDeletion: false };
    // Only for a proposal this agent proposed.
    if (!live.proposedByDelegate || lc(live.proposedByDelegate) !== lc(services.signer.address)) return { deleted: false, confirmedUnsignedDeletion: false };
    const signature = await services.signer.signDeleteRequest({ proposalId, chainId, safe: live.safe, totp: currentTotp() });
    await service.deleteTransaction(safeTxHash, signature);
    return { deleted: true, confirmedUnsignedDeletion: true };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return { deleted: false, confirmedUnsignedDeletion: false }; // refused or unreachable: it may still be there
  }
}

/** Boolean compatibility wrapper for callers that only need the queue removal result. */
export async function deleteIfUnconfirmed(ctx: Pick<SafeContext, "services">, proposalId: string, chainId: ChainId, safeTxHash: Hex, ownConfirmed: boolean): Promise<boolean> {
  return (await deleteIfUnconfirmedResult(ctx, proposalId, chainId, safeTxHash, ownConfirmed)).deleted;
}

export async function rejectProposal(ctx: SafeContext, proposalId: string): Promise<ProposalView> {
  const { db, wallet, safe } = ctx;
  const [row] = await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.safeId, safe.id))).limit(1);
  if (!row) throw new HttpError(404, "Proposal not found");
  const chainId = row.chainId as ChainId;
  requireNetwork(ctx.access, chainId);

  const view = (r: typeof row) => proposalView(r, { viewer: wallet, threshold: r.threshold ?? 2, safeAddress: getAddress(safe.address) as `0x${string}` });
  if (row.stage === "rejected") return view(row);
  if (row.stage === "sending") throw new HttpError(409, "This is being sent to Safe. Try again in a moment.");
  if (!REJECTABLE.includes(row.stage)) throw new HttpError(409, "This can no longer be rejected.");

  let deleted = false;
  let agentDeleted = false;
  let confirmedUnsignedDeletion = false;
  if (row.safeTxHash && !row.deletedFromQueue) {
    const result = await deleteIfUnconfirmedResult(ctx, row.id, chainId, row.safeTxHash as Hex, row.confirmations.length > 0);
    deleted = result.deleted;
    confirmedUnsignedDeletion = result.confirmedUnsignedDeletion;
    agentDeleted = confirmedUnsignedDeletion;
  } else if (row.deletedFromQueue) deleted = true;

  const previousTestRun = (row.testRun ?? {}) as Record<string, unknown>;
  const testRun = confirmedUnsignedDeletion ? { ...previousTestRun, confirmedUnsignedDeletion: true } : row.testRun;

  const [updated] = await db.update(proposals)
    .set({ stage: "rejected", deletedFromQueue: deleted, ...(testRun ? { testRun } : {}), updatedAt: new Date() })
    .where(and(eq(proposals.id, row.id), inArray(proposals.stage, REJECTABLE))).returning();
  if (!updated) throw new HttpError(409, "This changed while you were rejecting it. Check it again.");

  await recordActivity(db, {
    safeId: safe.id, chainId, actor: "You", actorAddress: wallet, kind: "status", proposalId: row.id, eventKey: `rejected:${row.id}`, safeTxHash: row.safeTxHash,
    text: !row.safeTxHash
      ? `You rejected "${row.title}". Nothing was sent.`
      : deleted
        ? `You rejected "${row.title}". It is no longer in your Safe queue.`
        : `You rejected "${row.title}" here. It is still in your Safe queue. Reject it in Safe too.`,
  });
  if (agentDeleted) {
    await recordActivity(db, {
      safeId: safe.id, chainId, actor: "Agent", kind: "status", proposalId: row.id, eventKey: `deleted:${row.id}`, safeTxHash: row.safeTxHash,
      text: `The Lender agent deleted "${row.title}" from your Safe queue.`,
    });
  }
  return view(updated);
}
