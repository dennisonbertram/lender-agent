// Edit and replace a proposal (BP-24, architecture 2 rule 3 and 8.2). "Make it $3,000 instead":
// the new plan is checked and tested first; only then is the old proposal taken out of the way.
// The old one is deleted from the Safe queue with the agent's signed DeleteRequest only when no
// owner confirmed it (the same rule as Reject, `deleteIfUnconfirmed`: the hosted service would
// delete a confirmed one too, M0-3). A confirmed or refused one stays in the queue: its card reads
// "Replaced" with "Still in your Safe queue. Reject it in Safe too.". The new proposal reuses the old
// one's nonce (D-10): they compete, so only one can ever execute, and a deleted original leaves no gap.
// Signing the new one does not cancel the old one's signatures; owners reject it in Safe. History is not rewritten:
// the old row stays, marked replaced.
import { and, desc, eq, inArray } from "drizzle-orm";
import { recordActivity } from "@/server/activity";
import { requireNetwork } from "@/server/auth/access";
import { proposals } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import type { Address, ChainId, Hex } from "@/shared/types";
import { completeReplacementCleanup, idempotencyKeyFor, reconcileSending, sendToSafe, sendToSafeLocked, withSafeSendLock, type SendInput, type SendResult } from "./send";

const REPLACEABLE = ["draft", "queued"];

/** An edit that lost track of what it replaces must not become a second proposal at the next nonce. */
export async function refuseEditWithoutReplaces(ctx: SafeContext, chainId: number): Promise<void> {
  const rows = await ctx.db.select({ spec: proposals.spec }).from(proposals)
    .where(and(eq(proposals.safeId, ctx.safe.id), eq(proposals.chainId, chainId), inArray(proposals.stage, REPLACEABLE)));
  if (rows.some((r) => (r.spec as { kind?: string }).kind === "open")) {
    throw new HttpError(409, "This edit has to replace your open proposal, but it did not say which one. Reload the chat and edit again so nothing is sent twice.");
  }
}

export type ReplaceResult = SendResult & { replacedId: string; oldStillInSafe: boolean };

export async function replaceProposal(ctx: SafeContext, oldId: string, input: SendInput): Promise<ReplaceResult> {
  return withSafeSendLock(ctx.safe.id, () => replaceProposalLocked(ctx, oldId, input));
}

async function replaceProposalLocked(ctx: SafeContext, oldId: string, input: SendInput): Promise<ReplaceResult> {
  const { db, safe, wallet } = ctx;
  const [old] = await db.select().from(proposals).where(and(eq(proposals.id, oldId), eq(proposals.safeId, safe.id))).limit(1);
  if (!old) throw new HttpError(404, "Proposal not found");
  const chainId = old.chainId as ChainId;
  requireNetwork(ctx.access, chainId);
  if (old.stage === "sending") throw new HttpError(409, "This is being sent to Safe. Try again in a moment.");
  if (!REPLACEABLE.includes(old.stage)) throw new HttpError(409, "This can no longer be replaced.");
  if ((old.spec as { kind?: string }).kind !== "open") throw new HttpError(409, "Only a loan proposal can be edited. Reject this one and ask again.");
  if (input.chainId !== chainId) throw new HttpError(400, "The new plan must be on the same network.");

  let stillInSafe = !!old.safeTxHash && !old.deletedFromQueue;
  let deletedByAgent = false;
  const cleanupAfterCommit = async (replacement: Parameters<typeof completeReplacementCleanup>[2]) => {
    const cleanup = await completeReplacementCleanup(db, ctx.services, replacement);
    stillInSafe = cleanup.oldStillInSafe;
    deletedByAgent = cleanup.deletedByAgent;
    if (!cleanup.ready) {
      throw new HttpError(409, cleanup.row.stopReason ?? "The original proposal changed while it was being replaced. Reload before sending again.");
    }
  };

  // Everything about the new plan is checked and tested before the reservation transaction runs; if it is blocked, the old proposal is untouched.
  // The original's place in the queue, unless the chain already passed it (then an ordinary next nonce).
  const onChain = (await ctx.services.reader.readSafeNonce(chainId, ctx.safe.address as Address)) ?? 0n;
  const nonce = old.nonce !== null && old.nonce >= onChain ? old.nonce : undefined;
  let committed = false;
  const sent = await sendToSafeLocked(ctx, input, { afterStore: async (row) => { committed = true; await cleanupAfterCommit(row); }, nonce, original: old }).catch((err) => {
    if (!committed || err instanceof HttpError) throw err;
    throw new HttpError(500, "The replacement was saved, but its delivery is still being checked. Check it again before trying another change.");
  });
  // Same transaction, same hash: nothing was changed, the original is still the proposal.
  if (sent.unchanged) return { ...sent, replacedId: old.id, oldStillInSafe: stillInSafe };
  const [neu] = await db.select().from(proposals).where(eq(proposals.id, sent.proposalId)).limit(1);
  await recordActivity(db, {
    safeId: safe.id, chainId, actor: "You", actorAddress: wallet, kind: "status", proposalId: sent.proposalId, eventKey: `replaced:${old.id}`, safeTxHash: neu!.safeTxHash,
    text: `Updated draft: ${neu!.title}`,
    detail: stillInSafe ? `"${old.title}" is still in your Safe queue. Reject it in Safe too.` : null,
  });
  if (deletedByAgent) {
    await recordActivity(db, {
      safeId: safe.id, chainId, actor: "Agent", kind: "status", proposalId: old.id, eventKey: `deleted:${old.id}`, safeTxHash: old.safeTxHash,
      text: `The Lender agent deleted "${old.title}" from your Safe queue.`,
    });
  }
  return { ...sent, replacedId: old.id, oldStillInSafe: stillInSafe };
}

/**
 * Send a plan; a new plan for a Safe replaces its earlier unexecuted loan plan from this agent (one nonce, one loan).
 * Without this a second plan sat beside the first, both signable, and two loans could open. The same plan pressed twice
 * is not an earlier plan: it falls through to `sendToSafe`, which returns the existing proposal.
 */
export async function sendPlan(ctx: SafeContext, input: SendInput): Promise<SendResult> {
  const key = idempotencyKeyFor(input.chainId, ctx.safe.address, input.draftKey);
  const load = () => ctx.db.select().from(proposals)
    .where(and(eq(proposals.safeId, ctx.safe.id), eq(proposals.chainId, input.chainId), inArray(proposals.stage, ["sending", "queued"])))
    .orderBy(desc(proposals.createdAt));
  let open = await load();
  // An earlier loan plan still being delivered holds a nonce nobody knows the fate of. Settle it first (the Service has it: queued;
  // refused: gone); if it stays unknown, a new nonce must not be handed out beside it, or both loans could execute.
  const unsettled = open.filter((r) => r.stage === "sending" && r.idempotencyKey !== key && (r.spec as { kind?: string }).kind === "open");
  if (unsettled.length) {
    for (const r of unsettled) await reconcileSending(ctx, r.id);
    open = await load();
    if (open.some((r) => r.stage === "sending" && r.idempotencyKey !== key && (r.spec as { kind?: string }).kind === "open")) {
      throw new HttpError(409, "An earlier plan is still being sent. Try again in a moment.");
    }
  }
  open = open.filter((r) => r.stage === "queued");
  const onChain = (await ctx.services.reader.readSafeNonce(input.chainId, ctx.safe.address as Address)) ?? 0n;
  const same = open.some((r) => r.idempotencyKey === key);
  const earlier = same ? undefined : open.find((r) => (r.spec as { kind?: string }).kind === "open" && r.nonce !== null && r.nonce >= onChain);
  return earlier ? replaceProposal(ctx, earlier.id, input) : sendToSafe(ctx, input);
}
