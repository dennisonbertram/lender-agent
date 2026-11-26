// Send to Safe (BP-14, architecture 2 rules 3-5 and 3.1 step 3). The record is stored as "sending"
// BEFORE anything is signed or sent: spec, exact transaction, nonce, computed hash, and idempotency
// key. Before the first POST, a committed intent makes that attempt one-way: every later worker only
// polls the Safe service and keeps the nonce if the hash is not visible yet.
import { createHash, randomUUID } from "node:crypto";
import { getMoveDeps } from "@/server/moves/deps";
import { gateMoveDelivery } from "@/server/moves/gate";
import { MOVE_NETWORKS } from "@/server/moves/networks";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { getAddress } from "viem";
import { usd } from "@/lib/format";
import { receiptLine } from "@/lib/plan-draft";
import { compute, type OpenSpec, type Spec } from "@/lib/proposals";
import { DEFAULT_LEVELS, healthFactor, MIN_LOAN } from "@/lib/loan-math";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import type { Asset } from "@/lib/types";
import { recordActivity } from "@/server/activity";
import { AGENT_LABEL, AGENT_OFF_MESSAGE, assertAgentActive, stopAgentProposals } from "@/server/agent-role";
import { requireNetwork } from "@/server/auth/access";
import type { Db } from "@/server/db/client";
import { proposals, safes } from "@/server/db/schema";
import { deleteIfUnconfirmed } from "./reject";
import { HttpError } from "@/server/http";
import { levelsForPlan } from "@/server/levels";
import { AAVE_VENUE_ID, AAVE_VENUE_NAME, M1_NETWORKS, liveInputs } from "@/server/market-inputs";
import { getDraft, markDraftOutOfDate } from "@/server/plan-drafts";
import { loansOf, pickLender, quotePlan, roundedVenue } from "@/server/quote";
import { testRun } from "@/server/proposals/test-run";
import type { SafeContext } from "@/server/request";
import { SafeServiceError } from "@/server/safe/service-client";
import { safeTxHash } from "@/server/safe/hash";
import type { Services } from "@/server/services";
import { servedChainOf } from "@/lib/networks";
import { CHAIN_NAME, isChainId, NETWORK_OF, type Address, type ChainId, type Hex, type ProposalStage, type SafeTx } from "@/shared/types";

export type SendInput = {
  /** From the plan draft (src/server/plan-drafts.ts): one per draft, so two presses are one proposal. */
  draftKey: string;
  chainId: ChainId;
  /** Dollars to borrow. The server recomputes collateral and every figure; it trusts no client figure. */
  cash: number;
  asset?: Asset;
  venueId?: string;
  /** The owner picked `venueId`: Send uses exactly that lender or refuses; it never switches. */
  venueChosen?: boolean;
  hfIdx?: 0 | 1 | 2;
  months?: number;
};

export type SendResult = {
  proposalId: string;
  stage: ProposalStage;
  /** "Sent to your Safe: …" once the service has it; null while unknown or when not sent. */
  receipt: string | null;
  /** An edit that produced the same transaction as the original: nothing was changed (replace.ts). */
  unchanged?: boolean;
  /** Why the service refused (stage "not_sent"). */
  error?: string;
};

/** A blocked test run (422): nothing is stored. */
export class SendBlocked extends HttpError {
  constructor(message: string, public readonly line: string) {
    super(422, message);
  }
}

type Ctx = Pick<SafeContext, "db" | "services">;
export type Row = typeof proposals.$inferSelect;
const isOpenLoan = (spec: unknown): boolean => typeof spec === "object" && spec !== null && "kind" in spec && spec.kind === "open";
const REPLACEABLE = ["draft", "queued"];

/**
 * Finish a replacement's durable cleanup phase before any request or worker can deliver its child.
 * The original's `replacedBy` link is committed alongside the child's sending row. If the request
 * stops before cleanup, the reconciler can safely resume it from that persisted link.
 */
export async function completeReplacementCleanup(db: Db, services: Services, replacement: Row): Promise<{
  ready: boolean;
  oldStillInSafe: boolean;
  deletedByAgent: boolean;
  row: Row;
}> {
  const [original] = await db.select().from(proposals).where(eq(proposals.replacedBy, replacement.id)).limit(1);
  if (!original || original.stage === "replaced") {
    return { ready: true, oldStillInSafe: !!original?.safeTxHash && !original.deletedFromQueue, deletedByAgent: false, row: replacement };
  }

  const blockChild = async (reason: string, refreshOriginal = false) => {
    if (!replacement.submissionAttemptedAt) {
      await db.update(proposals).set({ stage: "not_sent", stopReason: reason, updatedAt: new Date() })
        .where(and(eq(proposals.id, replacement.id), eq(proposals.stage, "sending"), isNull(proposals.submissionAttemptedAt)));
    }
    if (!replacement.submissionAttemptedAt) {
      await db.update(proposals).set({ replacedBy: null, updatedAt: new Date() }).where(and(eq(proposals.id, original.id), eq(proposals.replacedBy, replacement.id)));
    }
    if (refreshOriginal) await import("./follow").then(({ refreshProposal }) => refreshProposal(db, services, original.id)).catch(() => false);
    const [fresh] = await db.select().from(proposals).where(eq(proposals.id, replacement.id)).limit(1);
    return { ready: false, oldStillInSafe: !!original.safeTxHash && !original.deletedFromQueue, deletedByAgent: false, row: fresh ?? replacement };
  };

  if (!REPLACEABLE.includes(original.stage)) {
    return blockChild("The original proposal is no longer replaceable. Reload before sending again.");
  }
  if (replacement.submissionAttemptedAt) {
    return { ready: false, oldStillInSafe: !!original.safeTxHash && !original.deletedFromQueue, deletedByAgent: false, row: replacement };
  }

  let deleted = !!original.deletedFromQueue;
  if (original.safeTxHash && !deleted) {
    try {
      deleted = await deleteIfUnconfirmed({ services }, original.id, original.chainId as ChainId, original.safeTxHash as Hex, original.confirmations.length > 0);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        return blockChild("The original proposal already ran. The replacement was not sent; reload before editing again.", true);
      }
      throw error;
    }
    // Another worker may have completed the deletion between our initial read and delete call.
    if (!deleted) {
      const live = await services.safeService(original.chainId as ChainId).getMultisigTransaction(original.safeTxHash as Hex).catch(() => undefined);
      if (live?.isExecuted) return blockChild("The original proposal already ran. The replacement was not sent; reload before editing again.", true);
      if (live === null) deleted = true;
    }
  }

  const [completed] = await db.update(proposals).set({ stage: "replaced", deletedFromQueue: deleted, updatedAt: new Date() })
    .where(and(eq(proposals.id, original.id), inArray(proposals.stage, REPLACEABLE), eq(proposals.replacedBy, replacement.id))).returning({ id: proposals.id });
  if (!completed) {
    const [freshOriginal] = await db.select().from(proposals).where(eq(proposals.id, original.id)).limit(1);
    if (freshOriginal?.stage !== "replaced") return blockChild("The original proposal changed while it was being replaced. Reload before sending again.");
    deleted = freshOriginal.deletedFromQueue;
  }

  const [freshReplacement] = await db.select().from(proposals).where(eq(proposals.id, replacement.id)).limit(1);
  return {
    ready: true,
    oldStillInSafe: !!original.safeTxHash && !deleted,
    deletedByAgent: deleted && !!original.safeTxHash && !original.deletedFromQueue,
    row: freshReplacement ?? replacement,
  };
}
const safeSendQueues = new Map<number, Promise<void>>();

/** Serialize sends for a Safe within this process; the database advisory lock covers other workers. */
export async function withSafeSendLock<T>(safeId: number, work: () => Promise<T>): Promise<T> {
  const previous = safeSendQueues.get(safeId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  safeSendQueues.set(safeId, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (safeSendQueues.get(safeId) === current) safeSendQueues.delete(safeId);
  }
}

/** hfIdx 0..2: Extra safe, Balanced, Lean (the plan block's own list). */
const TARGET_HF = [2.0, DEFAULT_LEVELS.warn, DEFAULT_LEVELS.act] as const;

export const idempotencyKeyFor = (chainId: number, safe: string, draftKey: string) =>
  createHash("sha256").update(`${chainId}:${safe.toLowerCase()}:${draftKey}`).digest("hex");

const VENUE_NAMES: Record<string, string> = { [AAVE_VENUE_ID]: AAVE_VENUE_NAME, "compound-v3": "Compound v3", "morpho-blue": "Morpho" };
const venueNameOf = (spec: unknown) => VENUE_NAMES[(spec as OpenSpec).venueId] ?? "your lender";

/** "Sent to your Safe: …" from the stored spec, whatever the stage: it never recomputes. */
export function sentReceiptOf(row: Row): string | null {
  const spec = row.spec as OpenSpec | Extract<Spec, { kind: "move" }> | { kind: "close" | "repay" };
  if (spec.kind === "close" || spec.kind === "repay") return `Sent to your Safe: ${row.title}.`;
  if (spec.kind === "open") return receiptLine(spec, venueNameOf(spec), M1_NETWORKS);
  if (spec.kind === "move") return receiptLine(spec, venueNameOf(spec.then), MOVE_NETWORKS);
  return null;
}

const receiptOf = (row: Row): string | null => (row.stage === "queued" ? sentReceiptOf(row) : null);

export const resultOf = (row: Row): SendResult => ({
  proposalId: row.id,
  stage: row.stage as ProposalStage,
  receipt: receiptOf(row),
  ...(row.stage === "not_sent" ? { error: row.stopReason ?? "The Safe service did not accept it." } : {}),
  ...(row.stage === "sending" && row.submissionAttemptedAt && row.stopReason ? { error: row.stopReason } : {}),
});

// PGlite is a single-connection in-process database and cannot run a second transaction while the
// first awaits the Safe service. Serialize same-process calls before opening a transaction; the row
// lock below remains the cross-process guard for the production Postgres database.
const deliveryTails = new WeakMap<object, Map<string, Promise<void>>>();

async function withLocalDeliveryLock<T>(db: Db, id: string, run: () => Promise<T>): Promise<T> {
  const key = id;
  let byId = deliveryTails.get(db as object);
  if (!byId) deliveryTails.set(db as object, (byId = new Map()));
  const prior = byId.get(key) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => own);
  byId.set(key, tail);
  await prior;
  try {
    return await run();
  } finally {
    release();
    if (byId.get(key) === tail) byId.delete(key);
  }
}


async function reload(db: Db, id: string): Promise<Row> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  return row;
}

async function markQueued(db: Db, row: Row, safeId: number): Promise<Row> {
  const [updated] = await db.update(proposals).set({ stage: "queued", submissionAttemptedAt: row.submissionAttemptedAt ?? new Date(), stopReason: null, updatedAt: new Date() })
    .where(and(eq(proposals.id, row.id), eq(proposals.stage, "sending"))).returning();
  // A concurrent reconcile may have won; either way the Activity row is written once (eventKey).
  const steps = row.steps.filter((s) => !s.startsWith("Allow ")).join("; ");
  await recordActivity(db, {
    safeId, chainId: row.chainId as ChainId, actor: "Agent", kind: "proposed",
    text: `Sent "${row.title}" to your Safe queue.`, detail: steps || null, proposalId: row.id, eventKey: `proposed:${row.id}`,
  });
  return updated ?? (await reload(db, row.id));
}

/**
 * Stages that hold a Safe nonce: live ones ("sending", "queued"), plus a stopped one the service
 * still queues (a confirmed proposal that was replaced or rejected keeps its place).
 */
const NONCE_HOLDING = or(
  inArray(proposals.stage, ["sending", "queued"]),
  and(inArray(proposals.stage, ["replaced", "rejected", "stale", "stopped"]), eq(proposals.deletedFromQueue, false), isNotNull(proposals.safeTxHash)),
);

/** The lowest nonce at or above the chain's own that no live record already holds. */
function freeNonce(onChain: bigint, rows: { nonce: bigint | null }[]): bigint {
  const taken = new Set(rows.map((r) => r.nonce).filter((n): n is bigint => n !== null && n >= onChain));
  let next = onChain;
  while (taken.has(next)) next += 1n;
  return next;
}

/** Do not release an attempted nonce just because the Safe service has not indexed the hash yet. */
const SUBMISSION_PENDING_MESSAGE = "Safe submission outcome is still being checked. Review your Safe queue; do not send it again.";

/** A synchronous 4xx (except rate limiting/timeouts) is a definitive refusal. */
const isRefusal = (err: unknown): err is SafeServiceError =>
  err instanceof SafeServiceError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

function refusalReason(err: SafeServiceError): string {
  const body = err.body as { nonFieldErrors?: string[]; detail?: string } | undefined;
  return body?.nonFieldErrors?.[0] ?? body?.detail ?? `The Safe service refused it (${err.status}).`;
}

type SignedProposal = Awaited<ReturnType<Services["signer"]["signProposal"]>>;
type ClaimResult =
  | { kind: "claimed"; row: Row }
  | { kind: "poll"; row: Row }
  | { kind: "agent-removed"; row: Row }
  | { kind: "settled"; row: Row };

/**
 * A durable attempt timestamp is the one-way boundary before the first Safe service POST. The
 * transaction that writes it commits before the claimant posts; later workers only poll the hash.
 * This deliberately leaves a crash-after-claim record in "sending" for explicit operator review.
 */
export async function deliver(db: Db, services: Services, row: Row, safe: Address): Promise<Row> {
  return withLocalDeliveryLock(db, row.id, async () => {
    let current = await reload(db, row.id);
    if (!current || current.stage !== "sending") return current ?? row;
    const replacement = await completeReplacementCleanup(db, services, current);
    if (!replacement.ready) {
      if (!current.submissionAttemptedAt) return replacement.row;
      const polled = await pollSubmission(db, services, current);
      return await handleAgentRemovalAfterPoll(db, services, safe, polled);
    }
    current = await reload(db, row.id);
    if (!current || current.stage !== "sending") return current ?? row;
    if (current.submissionAttemptedAt) {
      return await handleAgentRemovalAfterPoll(db, services, safe, await pollSubmission(db, services, current));
    }

    // Signing is read-only and uses its own DB provider, so prepare it before opening a transaction.
    // The claimant rechecks the active delegate, Safe hash, and move gate under the row lock.
    let signed: SignedProposal | null = null;
    try {
      await assertAgentActive(services, current.chainId as ChainId, safe);
      const service = services.safeService(current.chainId as ChainId);
      if (!(await service.getMultisigTransaction(current.safeTxHash as Hex))) {
        if ((current.spec as { kind?: string }).kind !== "move") {
          signed = await services.signer.signProposal({ proposalId: current.id, chainId: current.chainId as ChainId, safe });
        } else {
          const gate = await gateMoveDelivery(db, getMoveDeps(services), current, safe);
          if (gate.ok) signed = await services.signer.signProposal({ proposalId: current.id, chainId: current.chainId as ChainId, safe });
        }
      }
    } catch {
      // The locked claim below settles a definite gate refusal. Unknown reads or signer failures
      // stay sending without an intent, so no request has been allowed to reach the Safe service.
    }

    const claim = await claimSubmission(db, services, current, safe, signed);
    if (claim.kind === "agent-removed") {
      await stopAgentProposals(db, services, current.safeId, current.id);
      return await reload(db, current.id);
    }
    if (claim.kind === "poll") {
      const polled = await pollSubmission(db, services, claim.row);
      return await handleAgentRemovalAfterPoll(db, services, safe, polled);
    }
    if (claim.kind === "settled") {
      return await handleAgentRemovalAfterPoll(db, services, safe, claim.row);
    }

    const service = services.safeService(claim.row.chainId as ChainId);
    try {
      await service.proposeTransaction({
        safe, tx: claim.row.tx as SafeTx, safeTxHash: claim.row.safeTxHash as Hex,
        sender: services.signer.address, signature: signed!.signature, origin: AGENT_LABEL,
      });
    } catch (err) {
      if (isRefusal(err)) {
        const settled = await settleExplicitRefusal(db, services, claim.row, refusalReason(err));
        return await handleAgentRemovalAfterPoll(db, services, safe, settled);
      }
      // Transport failures, timeouts, 5xx, 408 and 429 do not prove Safe rejected the request.
      // Polling is the only automatic recovery action after the intent has committed.
    }
    let polled = await pollSubmission(db, services, claim.row);
    if (polled.stage === "sending") polled = await retainPendingMessage(db, polled);
    return await handleAgentRemovalAfterPoll(db, services, safe, polled);
  });
}

/** The only worker allowed to submit is the one that commits the intent while holding this row lock. */
async function claimSubmission(db: Db, services: Services, row: Row, safe: Address, signed: SignedProposal | null): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(proposals).where(eq(proposals.id, row.id)).for("update").limit(1);
    if (!fresh || fresh.stage !== "sending") return { kind: "settled", row: fresh ?? row };
    if (fresh.submissionAttemptedAt) return { kind: "poll", row: fresh };

    const chainId = fresh.chainId as ChainId;
    const service = services.safeService(chainId);
    try {
      await assertAgentActive(services, chainId, safe);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return { kind: "agent-removed", row: fresh };
      return { kind: "settled", row: fresh };
    }
    try {
      if (await service.getMultisigTransaction(fresh.safeTxHash as Hex)) {
        return { kind: "settled", row: await markQueued(tx as unknown as Db, fresh, fresh.safeId) };
      }
    } catch {
      return { kind: "settled", row: fresh };
    }

    if ((fresh.spec as { kind?: string }).kind === "move") {
      const gate = await gateMoveDelivery(tx as unknown as Db, getMoveDeps(services), fresh, safe)
        .catch((error) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
      if (!gate.ok) {
        console.error(`[send] move proposal ${fresh.id} failed its pre-delivery check: ${gate.reason}`);
        return { kind: "settled", row: await settleNotSent(tx as unknown as Db, fresh, gate.reason) };
      }
    }
    if (!signed || signed.safeTxHash.toLowerCase() !== String(fresh.safeTxHash).toLowerCase()) return { kind: "settled", row: fresh };

    const [claimed] = await tx.update(proposals).set({ submissionAttemptedAt: new Date(), stopReason: null, updatedAt: new Date() })
      .where(and(eq(proposals.id, fresh.id), eq(proposals.stage, "sending"), isNull(proposals.submissionAttemptedAt))).returning();
    return claimed ? { kind: "claimed", row: claimed } : { kind: "poll", row: fresh };
  });
}

/** Read the Safe hash under the same row lock used by agent removal; absence never releases an intent. */
async function pollSubmission(db: Db, services: Services, row: Row): Promise<Row> {
  return db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(proposals).where(eq(proposals.id, row.id)).for("update").limit(1);
    if (!fresh || fresh.stage !== "sending" || !fresh.submissionAttemptedAt) return fresh ?? row;
    try {
      if (await services.safeService(fresh.chainId as ChainId).getMultisigTransaction(fresh.safeTxHash as Hex)) {
        return await markQueued(tx as unknown as Db, fresh, fresh.safeId);
      }
    } catch {
      // Keep the durable intent and nonce. A later worker poll may see the hash.
    }
    return fresh;
  });
}

/** A definitive service rejection can release the nonce, but only after a locked visibility check. */
async function settleExplicitRefusal(db: Db, services: Services, row: Row, reason: string): Promise<Row> {
  return db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(proposals).where(eq(proposals.id, row.id)).for("update").limit(1);
    if (!fresh || fresh.stage !== "sending" || !fresh.submissionAttemptedAt) return fresh ?? row;
    try {
      if (await services.safeService(fresh.chainId as ChainId).getMultisigTransaction(fresh.safeTxHash as Hex)) {
        return await markQueued(tx as unknown as Db, fresh, fresh.safeId);
      }
    } catch {
      // The service visibility check is uncertain, so retain the intent and its nonce.
      return fresh;
    }
    const [updated] = await tx.update(proposals).set({ stage: "not_sent", stopReason: reason, updatedAt: new Date() })
      .where(and(eq(proposals.id, fresh.id), eq(proposals.stage, "sending"), isNotNull(proposals.submissionAttemptedAt))).returning();
    return updated ?? fresh;
  });
}

async function retainPendingMessage(db: Db, row: Row): Promise<Row> {
  const [updated] = await db.update(proposals).set({ stopReason: SUBMISSION_PENDING_MESSAGE, updatedAt: new Date() })
    .where(and(eq(proposals.id, row.id), eq(proposals.stage, "sending"), isNotNull(proposals.submissionAttemptedAt))).returning();
  return updated ?? await reload(db, row.id);
}

/** Settle a pre-intent gate refusal. An attempted submission is never released through this path. */
async function settleNotSent(db: Db, row: Row, reason: string): Promise<Row> {
  const [updated] = await db.update(proposals).set({ stage: "not_sent", stopReason: reason, updatedAt: new Date() })
    .where(and(eq(proposals.id, row.id), eq(proposals.stage, "sending"), isNull(proposals.submissionAttemptedAt))).returning();
  return updated ?? await reload(db, row.id);
}

/** Agent-removal cleanup only runs after the current delivery transaction has released the row lock. */
async function handleAgentRemovalAfterPoll(db: Db, services: Services, safe: Address, row: Row): Promise<Row> {
  if (row.stage !== "sending" && row.stage !== "queued") return row;
  try {
    await assertAgentActive(services, row.chainId as ChainId, safe);
    return row;
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 409)) return row;
    await stopAgentProposals(db, services, row.safeId, row.id);
    return await reload(db, row.id);
  }
}

async function safeAddressOf(db: Db, safeId: number): Promise<Address> {
  const [s] = await db.select().from(safes).where(eq(safes.id, safeId)).limit(1);
  return getAddress(s.address) as Address;
}

/** Reconcile one "sending" record (see `deliver`). Other stages are returned unchanged. */
export async function reconcileSending(ctx: Ctx, proposalId: string): Promise<SendResult> {
  const row = await reload(ctx.db, proposalId);
  if (!row) throw new HttpError(404, "Proposal not found");
  if (row.stage !== "sending") return resultOf(row);
  return resultOf(await deliver(ctx.db, ctx.services, row, await safeAddressOf(ctx.db, row.safeId)));
}

/** For the worker: reconcile every "sending" record. Returns how many reached a final stage. */
export async function reconcileAllSending(db: Db, services: Services): Promise<number> {
  const rows = await db.select().from(proposals).where(eq(proposals.stage, "sending"));
  let settled = 0;
  for (const row of rows) {
    const after = await deliver(db, services, row, await safeAddressOf(db, row.safeId));
    if (after.stage !== "sending") settled++;
  }
  return settled;
}

/**
 * Nonce: the lowest nonce at or above the Safe's on-chain nonce that none of our own nonce-holding
 * proposals for this Safe and chain takes. A local row below the on-chain nonce already ran (or was
 * overtaken) and is not counted, so a proposal executed but not yet polled leaves no gap. A refusal
 * frees the nonce it held: the next ordinary proposal can take that lowest free place, leaving the
 * already queued transactions unchanged. Use `withNextProposalNonce` to allocate and store an
 * ordinary send together.
 * `"current"` (urgent fixes, D-10) is the Safe's on-chain nonce itself: a competing transaction that
 * does not wait behind anything queued.
 */
export async function nextNonce(db: Db, services: Services, safeId: number, chainId: ChainId, safe: Address, which: "next" | "current" = "next"): Promise<bigint> {
  const onChain = (await services.reader.readSafeNonce(chainId, safe)) ?? 0n;
  if (which === "current") return onChain;
  return nextUnoccupiedNonce(db, safeId, chainId, onChain);
}

async function nextUnoccupiedNonce(db: Pick<Db, "select">, safeId: number, chainId: ChainId, onChain: bigint): Promise<bigint> {
  const open = await db.select({ nonce: proposals.nonce }).from(proposals)
    .where(and(eq(proposals.safeId, safeId), eq(proposals.chainId, chainId), NONCE_HOLDING));
  return freeNonce(onChain, open);
}

type ProposalNonceTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ProposalNonceOptions = { draftKeys?: readonly string[]; retryKey?: string; nonce?: bigint; /** Opening-loan callers only; close, fix, move, and setup actions remain independent. */ blockPendingOpen?: boolean };

/** Choose and store an ordinary proposal's nonce in one transaction. Read the chain and finish external work before calling. */
export async function withNextProposalNonce<T>(db: Db, safeId: number, chainId: ChainId, onChain: bigint, store: (tx: ProposalNonceTx, nonce: bigint) => Promise<T>, options: ProposalNonceOptions = {}): Promise<T> {
  return db.transaction(async (tx) => {
    // Serialize sends for the whole Safe, not just one network: the Safe may hold positions on both.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`safe-proposal-send:${safeId}`}, 0))`);
    const pending = await tx.select({ id: proposals.id, chainId: proposals.chainId, idempotencyKey: proposals.idempotencyKey, spec: proposals.spec }).from(proposals)
      .where(and(eq(proposals.safeId, safeId), eq(proposals.stage, "sending")));
    const pendingLoan = options.blockPendingOpen && pending.find((p) => isOpenLoan(p.spec));
    if (pendingLoan && pendingLoan.idempotencyKey !== options.retryKey) throw new HttpError(409, "A loan plan is still being sent to this Safe. Wait for it to finish before sending another.");
    if (options.draftKeys?.length && (await tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.safeId, safeId), inArray(proposals.idempotencyKey, options.draftKeys), ne(proposals.stage, "not_sent")))).length) {
      throw new HttpError(409, "This plan was already sent on another network. Open it from Activity.");
    }
    // A waiter must see the previous sender's committed reservation in this statement.
    const nonce = options.nonce ?? await nextUnoccupiedNonce(tx, safeId, chainId, onChain);
    return store(tx, nonce);
  }, { isolationLevel: "read committed" });
}

/** The new sending row and its replacement link commit atomically; `afterStore` runs only after commit. */
export async function sendToSafe(ctx: SafeContext, input: SendInput, opts: { afterStore?: (row: Row) => Promise<void>; nonce?: bigint; original?: Row } = {}): Promise<SendResult> {
  return withSafeSendLock(ctx.safe.id, () => sendToSafeLocked(ctx, input, opts));
}

/** Internal entry for replaceProposal, which already holds the Safe-wide process lock. */
export async function sendToSafeLocked(ctx: SafeContext, input: SendInput, opts: { afterStore?: (row: Row) => Promise<void>; nonce?: bigint; original?: Row } = {}): Promise<SendResult> {
  const { db, services, safe, wallet } = ctx;
  const chainId = input.chainId;
  if (!isChainId(chainId)) throw new HttpError(400, "Unknown network.");
  if (typeof input.draftKey !== "string" || !input.draftKey) throw new HttpError(400, "Missing plan.");
  if (!Number.isFinite(input.cash) || input.cash <= 0) throw new HttpError(400, "Enter how much cash you want.");
  const hfIdx = input.hfIdx ?? 1;
  if (![0, 1, 2].includes(hfIdx)) throw new HttpError(400, "Unknown safety level.");
  requireNetwork(ctx.access, chainId);
  const safeAddress = getAddress(safe.address) as Address;
  await assertAgentActive(services, chainId, safeAddress);

  const key = idempotencyKeyFor(chainId, safe.address, input.draftKey);
  const [existing] = await db.select().from(proposals).where(eq(proposals.idempotencyKey, key)).limit(1);
  if (existing) {
    await opts.afterStore?.(existing);
    return resultOf(existing.stage === "sending" ? await deliver(db, services, existing, safeAddress) : existing);
  }
  const otherNetworkKeys = SERVED_CHAIN_IDS.filter((id) => id !== chainId).map((id) => idempotencyKeyFor(id, safe.address, input.draftKey));
  if ((await db.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.safeId, safe.id), inArray(proposals.idempotencyKey, otherNetworkKeys), ne(proposals.stage, "not_sent")))).length) {
    throw new HttpError(409, "This plan was already sent on another network. Open it from Activity.");
  }

  // A pending send belongs to the Safe even when another tab or network created it. Return no chain,
  // proposal id or receipt in this generic conflict response.
  const pending = await db.select({ spec: proposals.spec }).from(proposals).where(and(eq(proposals.safeId, safe.id), eq(proposals.stage, "sending")));
  if (pending.some((p) => isOpenLoan(p.spec))) {
    throw new HttpError(409, "A loan plan is still being sent to this Safe. Wait for it to finish before sending another.");
  }

  // Only the Safe's current live plan can be sent: a newer plan message makes this card "Earlier plan".
  const live = await getDraft(db, safe.id);
  if (!live || live.draftKey !== input.draftKey || live.outOfDate) {
    const reason = `Earlier plan for ${usd(input.cash)}. Use the newest plan.`;
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }
  if (live.hypothetical) throw new HttpError(409, "A sizing answer can't be sent. Plan a loan you can afford.");

  // The draft remembers the network it was quoted on: a send on another one is a stale plan, not a switch.
  const network = NETWORK_OF[chainId];
  if (live.network && live.network !== network) {
    const named = servedChainOf(live.network);
    const reason = `That plan is on ${named ? CHAIN_NAME[named] : live.network}. Re-quote it there, then send.`;
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }
  const quote = await quotePlan({ db, services, safe }, { cash: input.cash, asset: input.asset, network, chainId, venueId: input.venueId, ...(input.venueChosen ? { venueChosen: true } : {}), hfIdx, months: (input.months ?? 12) as 3 | 12 | 24 });
  if (quote.status === "unavailable") {
    await markDraftOutOfDate(db, safe.id, input.draftKey);
    const reason = quote.testRun.reason ?? "This plan is not available now.";
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }
  if (quote.quote.kind !== "ok" || quote.cash !== input.cash) {
    const reason = input.cash < MIN_LOAN ? "That is below the smallest loan." : quote.testRun.reason ?? "The Safe does not hold enough to lock for that plan.";
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }
  // The lender is chosen by venue (Aave by default); its adapter builds the batch (test-run.ts).
  const inputs = await liveInputs(services.reader, chainId, safeAddress, services.lenders);
  const facts = pickLender(inputs, input.venueId);
  // The quote and the transaction must be for one lender: a switch (the quote moved to another lender) is refused, never built.
  if (facts.id !== quote.venueId) throw new HttpError(409, `${facts.name} cannot take this plan now (the plan would move to another lender). Nothing was sent.`);
  const venue = facts.venue && !facts.unavailable ? roundedVenue(facts.venue) : null;
  const asset: Asset = quote.quote.asset as Asset; // the quote chose it (the existing loan's collateral, or the best default); never a Send default
  if (!venue || !venue.markets[asset]) throw new SendBlocked("This plan is not available now.", "This plan is not available now. Nothing was sent.");
  const spec: OpenSpec = { kind: "open", venueId: venue.id, asset, amount: quote.quote.collateral, borrow: input.cash, safeId: safe.address.toLowerCase(), network };
  const loanHf = facts.id === AAVE_VENUE_ID ? inputs.position?.healthFactor : facts.position?.health ?? undefined;
  const tr = await testRun({
    chainId, safe: safeAddress, spec, healthBefore: loanHf !== undefined && loanHf !== null && Number.isFinite(loanHf) ? loanHf : null,
    atRiskLevel: (await levelsForPlan(db, safe.id, facts.id === AAVE_VENUE_ID ? inputs.position?.id : facts.loan?.id)).act,
    ...(facts.id === AAVE_VENUE_ID ? {} : { predictedHealthAfter: quote.quote.price / quote.quote.liqPrice }),
  }, services.testRunDeps);
  if (!tr.canSend) throw new SendBlocked(tr.reason ?? "The test run did not pass.", tr.line);

  // The same venue, price and loans the quote used, so the card's words match the plan card.
  const shown = compute(spec, loansOf(inputs), { prices: { ...inputs.prices, ...facts.prices }, venues: [venue], networks: M1_NETWORKS, feeEstimateUsd: tr.feeUsd });
  const transactionAt = (nonce: bigint) => {
    const tx: SafeTx = { ...tr.tx, nonce: nonce.toString() };
    return { tx, safeTxHash: safeTxHash(chainId, safeAddress, tx) };
  };
  // A replacement competes with the original: it passes the original's nonce so only one of them can execute (D-10).
  const fixed = opts.nonce === undefined ? undefined : transactionAt(opts.nonce);
  // The same transaction at the same nonce has the same hash: the unique index would refuse the insert after the original was already marked replaced. Change nothing instead.
  if (fixed && opts.original?.safeTxHash && opts.original.safeTxHash.toLowerCase() === fixed.safeTxHash.toLowerCase()) {
    return { ...resultOf(opts.original), unchanged: true, receipt: "This proposal is already in your Safe queue, unchanged." };
  }
  // Finish external reads before the reservation transaction marks the original as replaced.
  const startingNonce = opts.nonce ?? await nextNonce(db, services, safe.id, chainId, safeAddress, "current");
  const threshold = await services.reader.readSafeThreshold(chainId, safeAddress);

  // Stored before signing. A loser of an insert race gets the winner's record.
  const store = async (storage: ProposalNonceTx, nonce: bigint) => {
    const inserted = await storage.insert(proposals).values({
      id: randomUUID(), safeId: safe.id, chainId, spec, ...(fixed ?? transactionAt(nonce)), nonce, idempotencyKey: key,
      title: shown.title, steps: shown.steps, outcome: shown.outcome, stage: "sending", threshold,
      testRun: { ok: tr.ok, feeUsd: tr.feeUsd, healthAfter: Number.isFinite(tr.healthAfter) ? tr.healthAfter : null, reason: tr.reason ?? null },
      createdBy: wallet.toLowerCase(),
    }).onConflictDoNothing({ target: proposals.idempotencyKey }).returning();
    if (opts.original && inserted[0]) {
      const [linked] = await storage.update(proposals).set({ replacedBy: inserted[0].id, updatedAt: new Date() })
        .where(and(eq(proposals.id, opts.original.id), inArray(proposals.stage, ["draft", "queued"]), isNull(proposals.replacedBy))).returning({ id: proposals.id });
      if (!linked) throw new HttpError(409, "This changed while you were editing it. Check it again.");
    }
    return inserted;
  };
  const insertion = withNextProposalNonce(db, safe.id, chainId, startingNonce, store, {
    draftKeys: otherNetworkKeys,
    retryKey: key,
    nonce: opts.nonce,
    blockPendingOpen: true,
  });
  const inserted = await insertion.catch(async (err) => {
    // The identical plan at the same nonce is already live (another tab): say so plainly instead of a bare 500.
    const pg = (err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } });
    const code = pg.code ?? pg.cause?.code, constraint = pg.constraint ?? pg.cause?.constraint;
    if (code === "23505" && constraint === "proposals_hash_idx") {
      throw new HttpError(409, "This exact plan is already in your Safe queue. Open it from Activity, or change the amount and send again.");
    }
    throw err;
  });
  if (inserted.length === 0) {
    const [winner] = await db.select().from(proposals).where(eq(proposals.idempotencyKey, key)).limit(1);
    await opts.afterStore?.(winner);
    return resultOf(winner);
  }
  // The reservation transaction has committed. Replacement cleanup may call the Safe Service and signer here;
  // the durable `sending` row blocks another network while that external work is in flight.
  await opts.afterStore?.(inserted[0]);
  return resultOf(await deliver(db, services, inserted[0], safeAddress));
}
