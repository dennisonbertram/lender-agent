// The reserve executor (BP-41, BP-42, BP-52): called by the monitor tick after a loan's snapshot is stored.
// With a linked, active Reserve and health below the trigger, it claims a run, drives it through the locked
// broadcast gate in `broadcast.ts` (which signs and commits hash + raw transaction before any RPC can see it),
// submits it through the same locked re-authorization, waits for the receipt outside the lock, and only then
// reports. What the reserve cannot cover is drafted for the main Safe through the normal fix path.
// It never throws: the tick must go on.
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { DEFAULT_LEVELS, reserveTargetHf } from "@/lib/loan-math";
import { unmetNote } from "@/lib/reserve";
import { allowanceNow } from "../allowance";
import { fixStateFor } from "@/server/fixes/draft";
import { draftFix } from "@/server/fixes";
import type { ChainReader } from "@/server/chain/reader";
import type { Db } from "@/server/db/client";
import { reserveRuns, safeNetworks, safes } from "@/server/db/schema";
import type { EmailProvider } from "@/server/email/provider";
import { levelsByLoan } from "@/server/levels";
import { sumUsd } from "@/server/loans";
import type { SafeContext } from "@/server/request";
import { getServices, type Services } from "@/server/services";
import type { Hex } from "viem";
import type { Address, ChainId, LoanPosition } from "@/shared/types";
import { reconcilePolicyChanges } from "../policy-change/reconcile";
import type { ExecLink } from "../types";
import { asPrepared, claimExpiredRun, failExpiredRun, gateHandoff, gateTarget, isUnsignedClaim, submitPreparedIfAuthorized, CLAIM_DEAD_MS, HANDOFF_LEASE_MS, NONCE_DEAD_GRACE_MS, type PreparedRepay, type ReserveRun } from "./broadcast";
import type { ReceiptResult } from "./chain";
import { emailOwners, leftLine, reportDone, reportFailure, retryEmails, type ReserveCard } from "./notify";
import { planReserveRepay, type ExecPlan } from "./plan";
import { getReserveRuntime, type ReserveRuntime } from "./runtime";
import { expiredSignedHandoff, linkFingerprint, loadReserveLink, releaseExpiredUnwatchedHandoff } from "./store";

export type ExecutorDeps = {
  db: Db;
  reader: ChainReader;
  now: Date;
  log: (message: string, detail?: unknown) => void;
  email?: EmailProvider | null;
  services?: Services;
  runtime?: ReserveRuntime;
};

export type ReserveRunOutcome =
  | { status: "skipped"; reason: "no-reserve" | "off" | "not-needed" | "unsupported-loan" | "no-room" | "changed" }
  | { status: "done"; runId: number; txHash: string; hfBefore: number; hfAfter: number | null; draftId?: string }
  | { status: "failed"; runId: number; error: string; draftId?: string }
  /** A prepared transaction is recorded, with no confirmed outcome yet. */
  | { status: "pending"; runId: number; txHash: string };

const scaleOf = (l: ExecLink) => 10 ** l.tokenDecimals;
const units = (raw: bigint, l: ExecLink) => Number(raw) / scaleOf(l);

/** A SafeContext that can only draft: the agent drafts for the owners and sends nothing (the owners sign in Safe). */
async function draftContext(deps: ExecutorDeps, services: Services, safeId: number, chainId: ChainId): Promise<SafeContext> {
  const [safe] = await deps.db.select().from(safes).where(eq(safes.id, safeId));
  return { db: deps.db, services, safe, networks: [], session: null as never, wallet: services.signer.address,
    access: { ownedChainIds: [chainId], trackedChainIds: [chainId], chat: true, ownersDiffer: false } };
}

/** Draft what the reserve could not cover as a normal fix for the main Safe; null when one is already open or none can be sized. */
async function draftRest(deps: ExecutorDeps, services: Services, link: ExecLink, position: LoanPosition): Promise<{ draftId: string; healthAfter: number | null } | { error: string } | null> {
  const open = await fixStateFor(deps.db, link.safeId, position.id);
  if (open.fix !== "none") return null;
  try {
    const d = await draftFix(await draftContext(deps, services, link.safeId, link.chainId), { loanId: position.id, option: "repay" });
    return { draftId: d.id, healthAfter: d.healthAfter };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const pendingRun = (run: ReserveRun) => and(
  eq(reserveRuns.id, run.id), eq(reserveRuns.status, "pending"),
  run.txHash === null ? isNull(reserveRuns.txHash) : eq(reserveRuns.txHash, run.txHash),
);

async function settledElsewhere(db: Db, run: ReserveRun): Promise<ReserveRunOutcome> {
  const [current] = await db.select().from(reserveRuns).where(eq(reserveRuns.id, run.id));
  if (current?.status === "done") {
    return { status: "done", runId: run.id, txHash: current.txHash!, hfBefore: current.hfBefore, hfAfter: current.hfAfter };
  }
  if (current?.status === "failed") {
    return { status: "failed", runId: run.id, error: current.error ?? "The reserve could not repay." };
  }
  return { status: "pending", runId: run.id, txHash: run.txHash! };
}

async function reportPending(db: Db, rt: ReserveRuntime, run: ReserveRun, message: string): Promise<void> {
  const [updated] = await db.update(reserveRuns).set({ error: message })
    .where(and(pendingRun(run), or(isNull(reserveRuns.error), ne(reserveRuns.error, message))))
    .returning({ id: reserveRuns.id });
  if (updated) rt.operatorAlert(`Reserve run ${run.id} is pending: ${message}`, { runId: run.id, txHash: run.txHash });
}

type DoneInput = { txHash: string; hf: number; target: number; capReached: boolean; origin: string; balanceBeforeRaw: bigint | null };

/** The mined transaction's verified sender and nonce, persisted with the terminal status so the executor nonce floor stays exact. */
type MinedIdentity = { executorAddress: Address; nonce: number };

/** A mined, successful repay: read the chain again, store the figures, draft the rest, report. Shared by the same-tick path and `reconcileRuns`. */
async function settleDone(deps: ExecutorDeps, services: Services, link: ExecLink, run: typeof reserveRuns.$inferSelect, d: DoneInput, mined?: MinedIdentity): Promise<ReserveRunOutcome> {
  const { db, reader, log } = deps;
  const rt = deps.runtime ?? getReserveRuntime(services, log);
  const sameLink = run.linkFingerprint === null || run.linkFingerprint === linkFingerprint(link);
  const [after, readAfter] = await Promise.all([
    reader.readAavePosition(link.chainId, link.mainSafe).catch(() => null),
    sameLink ? rt.chain.read(link).catch(() => null) : null,
  ]);
  const balAfter = readAfter?.balance ?? null;
  const hfAfter = after ? after.position?.healthFactor ?? Infinity : null;
  // A reconciled run has no balance from before the call: the amount requested is what the role was charged.
  const paidRaw = balAfter === null ? null : d.balanceBeforeRaw === null ? BigInt(run.requestedRaw) : d.balanceBeforeRaw - balAfter;
  const allowanceAfter = readAfter ? allowanceNow(readAfter.allowance, readAfter.nowSec).left : null;
  const [done] = await db.update(reserveRuns).set({
    status: "done", txHash: d.txHash, error: null, paidRaw: paidRaw?.toString() ?? null,
    hfAfter: hfAfter !== null && Number.isFinite(hfAfter) ? hfAfter : null,
    allowanceLeftRaw: allowanceAfter?.toString() ?? null, balanceLeftRaw: balAfter?.toString() ?? null,
    ...(mined ? { executorAddress: mined.executorAddress.toLowerCase(), nonce: mined.nonce } : {}),
  }).where(pendingRun(run)).returning();
  if (!done) return settledElsewhere(db, run);
  if (!after || hfAfter === null || balAfter === null || paidRaw === null || allowanceAfter === null) {
    // The exact receipt settles the run even if the reporting reads failed or refer to a different reserve.
    await reportDone(deps, done);
    return { status: "done", runId: done.id, txHash: d.txHash, hfBefore: d.hf, hfAfter };
  }
  const repaid = units(paidRaw, link);
  const still = after.position && Number.isFinite(hfAfter) && hfAfter < d.target - 1e-6;
  const rest = still ? await draftRest(deps, services, link, after.position!) : null;
  const capReached = d.capReached || (d.balanceBeforeRaw === null && allowanceAfter <= 0n);
  const note = rest && "draftId" in rest ? unmetNote(capReached, rest.healthAfter ?? hfAfter) : rest ? `${capReached ? "The daily limit is reached." : "The reserve ran out."} I could not draft the rest: ${rest.error}` : undefined;
  const card: ReserveCard = {
    runId: done.id,
    what: `Repaid ${repaid.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${link.tokenSymbol} from your Reserve Safe on your loan.`,
    why: d.origin === "now" ? "You asked to use the reserve." : `Health fell below your reserve trigger of ${link.trigger.toFixed(2)}.`,
    hfBefore: d.hf, hfAfter: Number.isFinite(hfAfter) ? hfAfter : 0, left: leftLine(units(balAfter, link), units(allowanceAfter, link), link.tokenSymbol),
    ...(note ? { note } : {}), ...(rest && "draftId" in rest ? { draftId: rest.draftId } : {}),
  };
  if (rest && "draftId" in rest) await db.update(reserveRuns).set({ restDraftId: rest.draftId }).where(eq(reserveRuns.id, done.id));
  await reportDone(deps, done, { card, usd: repaid, repay: repaid, asset: link.tokenSymbol, hfBefore: d.hf, hfAfter: Number.isFinite(hfAfter) ? hfAfter : 0, origin: d.origin });
  try { await emailOwners(deps, done); } catch (e) { log("reserve: email failed", e); }
  return { status: "done", runId: done.id, txHash: d.txHash, hfBefore: d.hf, hfAfter, ...(rest && "draftId" in rest ? { draftId: rest.draftId } : {}) };
}

/** Reporting half of a failure (the run row is already `failed`): operator alert, the rest-draft, the owners' alert. Shared with the gate, which marks the run failed inside its transaction. */
async function reportFailedOutcome(deps: ExecutorDeps, services: Services, rt: ReserveRuntime, link: ExecLink, run: typeof reserveRuns.$inferSelect, position: LoanPosition | null, error: string): Promise<ReserveRunOutcome> {
  const { db } = deps;
  rt.operatorAlert(`reserve repay failed for ${position?.id ?? run.loanId}: ${error}`, { runId: run.id, txHash: run.txHash });
  const rest = position ? await draftRest(deps, services, link, position) : null;
  if (rest && "draftId" in rest) await db.update(reserveRuns).set({ restDraftId: rest.draftId }).where(eq(reserveRuns.id, run.id));
  await reportFailure(deps, run, position, error);
  return { status: "failed", runId: run.id, error, ...(rest && "draftId" in rest ? { draftId: rest.draftId } : {}) };
}

/** The repay did not happen (refused, or reverted on-chain). Nothing is reported as done; the owners get the normal alert and the operator is told. */
async function settleFailed(deps: ExecutorDeps, services: Services, rt: ReserveRuntime, link: ExecLink, run: typeof reserveRuns.$inferSelect, position: LoanPosition | null, error: string, mined?: MinedIdentity): Promise<ReserveRunOutcome> {
  const { db } = deps;
  const [failed] = await db.update(reserveRuns).set({ status: "failed", error, ...(mined ? { executorAddress: mined.executorAddress.toLowerCase(), nonce: mined.nonce } : {}) }).where(pendingRun(run)).returning();
  if (!failed) return settledElsewhere(db, run);
  return reportFailedOutcome(deps, services, rt, link, failed, position, error);
}

const DIFFERENT_RECEIPT = "The network returned a different transaction's receipt. An operator must verify the original repay.";

/**
 * Settle a handed-off run from its mined receipt (shared by the tick's reconcile pass and a resumed run):
 * success reports done, a revert reports the failure, nothing settles on an unknown one.
 */
async function settleFromReceipt(deps: ExecutorDeps, services: Services, rt: ReserveRuntime, link: ExecLink, run: ReserveRun, r: NonNullable<ReceiptResult>, position: LoanPosition | null): Promise<boolean> {
  const { db } = deps;
  if (r.transactionHash.toLowerCase() !== run.txHash?.toLowerCase()) {
    await reportPending(db, rt, run, DIFFERENT_RECEIPT);
    return false;
  }
  // A pre-upgrade run can carry only the hash: settle it only when the mined transaction proves its
  // sender and nonce, persisting that identity with the terminal status so the executor nonce floor
  // stays exact. Unverifiable or disagreeing evidence stays pending for an operator — the sender is
  // never guessed from the current link, which may have rotated keys since.
  let mined: MinedIdentity | undefined;
  if (run.executorAddress === null || run.nonce === null) {
    const from = r.executorAddress?.toLowerCase();
    if (from === undefined || r.nonce === undefined
      || (run.executorAddress !== null && run.executorAddress !== from)
      || (run.nonce !== null && run.nonce !== r.nonce)) {
      await reportPending(db, rt, run, "The mined transaction's sender and nonce could not be confirmed against the stored evidence. An operator must reconcile the run before another repay can proceed.");
      return false;
    }
    mined = { executorAddress: from as Address, nonce: r.nonce };
  }
  if (r.status === "success") {
    const levels = (await levelsByLoan(db, link.safeId)).get(run.loanId) ?? DEFAULT_LEVELS;
    await settleDone(deps, services, link, run, { txHash: run.txHash!, hf: run.hfBefore, target: reserveTargetHf(levels, link.trigger), capReached: false, origin: run.origin, balanceBeforeRaw: null }, mined);
  } else {
    await settleFailed(deps, services, rt, link, run, position, "The repay transaction reverted on-chain.", mined);
  }
  return true;
}

// Older runs recorded a hash without signed bytes or an intent timestamp. They can only check receipts.
const committedOrLegacyRun = or(
  isNotNull(reserveRuns.broadcastAt),
  and(isNotNull(reserveRuns.txHash), isNull(reserveRuns.signedTx), isNull(reserveRuns.leaseExpiresAt)),
);

const unwatchedRun = (now: Date) => or(committedOrLegacyRun, expiredSignedHandoff(now));

/** Unwatched networks recover committed transactions and release expired handoffs without intent. */
async function reconcileRuns(deps: ExecutorDeps, link: ExecLink, position: LoanPosition | null, unwatched = false): Promise<boolean> {
  const { db, log, now } = deps;
  const services = deps.services ?? getServices();
  const rt = deps.runtime ?? getReserveRuntime(services, log);
  const pending = await db.select().from(reserveRuns).where(and(
    eq(reserveRuns.safeId, link.safeId), eq(reserveRuns.chainId, link.chainId), eq(reserveRuns.status, "pending"),
    unwatched ? unwatchedRun(now) : undefined,
  ));
  let settled = false;
  for (const run of pending) {
    try {
      if (isUnsignedClaim(run)) {
        if (run.leaseExpiresAt > now) continue;
        if (now.getTime() - run.createdAt.getTime() > CLAIM_DEAD_MS) {
          const error = "The repay could not be prepared in time; nothing was broadcast.";
          const failed = await failExpiredRun(db, run, now, error);
          if (failed) {
            settled = true;
            await reportFailedOutcome(deps, services, rt, link, failed, position, error);
          }
          continue;
        }

        const claimed = await claimExpiredRun(db, run, now);
        if (!claimed) continue;
        const verdict = await gateHandoff(deps, rt, claimed, { target: await gateTarget(db, link.safeId, run.loanId, link.trigger) });
        if (verdict.kind === "handoff") {
          await retryPrepared(verdict.run, verdict.tx, verdict.link);
        } else if (verdict.kind === "failed") {
          settled = true;
          await reportFailedOutcome(deps, services, rt, link, verdict.run, position, verdict.error);
        }
        continue;
      }

      if (!run.txHash) {
        await reportPending(db, rt, run, "Broadcast evidence is missing. An operator must reconcile the run before another repay can proceed.");
        continue;
      }

      const hash = run.txHash as Hex;
      const prepared = asPrepared(run);
      if (prepared && run.broadcastAt === null) {
        // No send is possible before intent commits. Recheck the handoff under the submission lock.
        if (unwatched) await releaseExpiredUnwatchedHandoff(db, link.safeId, link.chainId, run.id, now);
        else await retryPrepared(run, prepared);
        continue;
      }

      // A run without a committed sender+nonce needs the transaction verified against the receipt.
      const receipt = await rt.chain.receipt(link, hash, run.executorAddress === null || run.nonce === null);
      if (receipt) {
        settled = await settleFromReceipt(deps, services, rt, link, run, receipt, position) || settled;
        continue;
      }

      if (!prepared) {
        await reportPending(db, rt, run, "Only the receipt can settle this legacy repay automatically. An operator must investigate if it remains pending.");
        continue;
      }

      if (run.broadcastAt && now.getTime() - run.broadcastAt.getTime() > NONCE_DEAD_GRACE_MS) {
        const finalized = await rt.chain.nonce({ chainId: link.chainId, executor: run.executorAddress as Address }, "finalized");
        if (finalized > prepared.nonce) {
          // The receipt and finalized nonce can come from different nodes. An advanced nonce cannot
          // identify the transaction that consumed it, so a missing receipt cannot release this run.
          const recheck = await rt.chain.receipt(link, hash);
          if (recheck) settled = await settleFromReceipt(deps, services, rt, link, run, recheck, position) || settled;
          else await reportPending(db, rt, run, "The finalized nonce advanced without a matching receipt. An operator must verify which transaction used it.");
          continue;
        }
      }

      await retryPrepared(run, prepared);
    } catch {
      log(`reserve: run ${run.id} (${run.txHash}) could not be checked; it will be retried`);
    }
  }
  return settled;

  async function retryPrepared(run: ReserveRun, prepared: PreparedRepay, checkReceiptFor?: ExecLink): Promise<void> {
    const sub = await submitPreparedIfAuthorized(deps, rt, run, prepared);
    if (sub.kind === "failed") {
      settled = true;
      await reportFailedOutcome(deps, services, rt, link, sub.run, position, sub.error);
    } else if (sub.kind === "unknown") {
      await reportPending(db, rt, run, sub.error);
    } else if (sub.kind === "submitted" && checkReceiptFor) {
      const receipt = await rt.chain.receipt(checkReceiptFor, prepared.hash);
      if (receipt) settled = await settleFromReceipt(deps, services, rt, checkReceiptFor, run, receipt, position) || settled;
    }
  }
}

/** Read the chain, size the repay, claim the run, gate it, submit it, read the receipt, report. `origin` "now" is "Use reserve now" (no trigger check; `authorizedBy` is the wallet the gate re-verifies). */
export async function executeReserve(deps: ExecutorDeps, input: { link: ExecLink; position: LoanPosition; origin: "auto" | "now"; authorizedBy?: Address; target?: number; keySuffix?: string; maxAmountRaw?: bigint }): Promise<ReserveRunOutcome> {
  const { db, reader, now, log } = deps;
  const { link, position, origin } = input;
  const services = deps.services ?? getServices();
  const rt = deps.runtime ?? getReserveRuntime(services, log);
  if (!link.active) return { status: "skipped", reason: "off" };
  const hf = position.healthFactor;
  const debt = position.debt.length === 1 && position.debt[0].asset === link.tokenSymbol ? position.debt[0] : null;
  // The role only allows Aave Pool.repay: for any other lender the normal alert flow applies.
  if (position.lender !== "aave-v3" || !debt || position.collateral.length === 0 || position.chainId !== link.chainId) return { status: "skipped", reason: "unsupported-loan" };
  if (!Number.isFinite(hf) || (origin === "auto" && hf >= link.trigger)) return { status: "skipped", reason: "not-needed" };
  if (origin === "now" && (input.maxAmountRaw === undefined || input.maxAmountRaw <= 0n)) return { status: "skipped", reason: "no-room" };

  // The chain's own view: allowance left (lazy refill computed here) and the Reserve Safe's balance.
  const { allowance: state, nowSec, balance: balanceRaw } = await rt.chain.read(link);
  const leftRaw = allowanceNow(state, nowSec).left;
  const requestLimitRaw = origin === "now"
    ? [leftRaw, balanceRaw, input.maxAmountRaw!].reduce((min, value) => value < min ? value : min)
    : leftRaw;
  const levels = (await levelsByLoan(db, link.safeId)).get(position.id.toLowerCase()) ?? DEFAULT_LEVELS;
  const target = input.target ?? reserveTargetHf(levels, link.trigger);
  const collateralUsd = sumUsd(position.collateral);
  if (collateralUsd === null) return { status: "skipped", reason: "unsupported-loan" }; // no dollar price: never guess
  const plan: ExecPlan | null = planReserveRepay({
    collateralUsd, lt: position.liquidationThreshold, debt: debt.amount, trigger: origin === "now" ? Infinity : link.trigger, target,
    balance: units(balanceRaw, link), allowanceLeft: units(requestLimitRaw, link), decimals: link.tokenDecimals, allowanceLeftRaw: requestLimitRaw,
  });
  if (!plan) return { status: "skipped", reason: "not-needed" };

  // Any pending run for this loan is in flight — claimed or handed off: fail closed rather than risk a
  // duplicate repay. The same check runs again under the link row lock inside the gate.
  const [inFlight] = await db.select({ id: reserveRuns.id }).from(reserveRuns).where(and(eq(reserveRuns.safeId, link.safeId), eq(reserveRuns.loanId, position.id.toLowerCase()), eq(reserveRuns.status, "pending"))).limit(1);
  if (inFlight) return { status: "skipped", reason: "no-room" };

  const key = `${origin}:${position.id.toLowerCase()}:${input.keySuffix ?? now.getTime()}`;
  const claimed = plan.requestRaw > 0n
    ? await db.insert(reserveRuns).values({
      safeId: link.safeId, chainId: link.chainId, loanId: position.id.toLowerCase(), key, status: "pending",
      requestedRaw: String(plan.requestRaw), hfBefore: hf, origin,
      linkFingerprint: linkFingerprint(link), authorizedBy: input.authorizedBy?.toLowerCase() ?? null,
      leaseExpiresAt: new Date(now.getTime() + HANDOFF_LEASE_MS),
    }).onConflictDoNothing({ target: reserveRuns.key }).returning()
    : [];
  if (plan.requestRaw > 0n && claimed.length === 0) return { status: "skipped", reason: "no-room" }; // this tick already acted

  let run = claimed[0];
  if (plan.requestRaw > 0n) {
    // The gate holds the link row lock for the bounded authorization/preparation decision only: flag, generation,
    // caller ownership, live position, nonce allocation, signing, and the durable handoff commit.
    const verdict = await gateHandoff(deps, rt, run!, { target });
    if (verdict.kind === "skipped") return { status: "skipped", reason: verdict.reason };
    if (verdict.kind === "failed") return reportFailedOutcome(deps, services, rt, link, verdict.run, position, verdict.error);

    const { link: broadcastLink, tx } = verdict;
    run = verdict.run;
    const sub = await submitPreparedIfAuthorized(deps, rt, run, tx);
    if (sub.kind === "settled") return settledElsewhere(db, run);
    if (sub.kind === "failed") return reportFailedOutcome(deps, services, rt, broadcastLink, sub.run, position, sub.error);
    if (sub.kind === "unknown") {
      await reportPending(db, rt, run, sub.error);
      return { status: "pending", runId: run.id, txHash: tx.hash };
    }
    // Receipt waiting is outside the link lock. The transaction remains durable if the RPC fails.
    const receipt = await rt.chain.waitReceipt(broadcastLink, tx.hash).catch(() => null);
    if (!receipt || receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) {
      await reportPending(db, rt, run, receipt ? DIFFERENT_RECEIPT : "The network accepted the repay, but its receipt could not be read in time.");
      return { status: "pending", runId: run.id, txHash: tx.hash };
    }
    if (receipt.status === "success") {
      // The receipt said success; the figures are read after it.
      return settleDone(deps, services, broadcastLink, run!, { txHash: tx.hash, hf, target, capReached: plan.capReached, origin, balanceBeforeRaw: verdict.balanceBeforeRaw });
    }
    return settleFailed(deps, services, rt, broadcastLink, run!, position, "The repay transaction reverted on-chain.");
  }

  // The reserve cannot act (allowance used or no balance): draft the whole need for the main Safe, once.
  const rest = await draftRest(deps, services, link, position);
  if (rest && "draftId" in rest) {
    const note = unmetNote(true, rest.healthAfter ?? hf);
    const why = leftRaw <= 0n ? "Today's reserve limit is used." : "The reserve has no stablecoin for this loan.";
    const { appendServerMessage } = await import("@/server/agent/persist");
    await appendServerMessage(db, link.safeId, { id: `reserve-rest-${rest.draftId}`, parts: [{ type: "data-reserve", data: { runId: 0, what: "The reserve did not repay.", why, hfBefore: hf, hfAfter: hf, left: leftLine(units(balanceRaw, link), units(leftRaw, link), link.tokenSymbol), note, draftId: rest.draftId } }] as never });
    return { status: "skipped", reason: "no-room" };
  }
  return { status: "skipped", reason: "no-room" };
}

/** Every tick, per Reserve link and independent of loan snapshots: a repay that cleared the whole loan leaves no loan to snapshot, so its run is settled here. Never throws. */
export async function reconcileReserveRuns(deps: ExecutorDeps, safeId: number, chainId: ChainId, unwatched = false): Promise<void> {
  try {
    const link = await loadReserveLink(deps.db, safeId, chainId);
    if (link) await reconcileRuns(deps, link, null, unwatched);
  } catch (e) {
    deps.log(`reserve: reconcile runs for ${safeId}:${chainId} failed`, e);
  }
}

/** After agent removal, clear expired reservations and check previously committed transactions. */
export async function reconcileUnwatchedReserveRuns(deps: ExecutorDeps): Promise<void> {
  const { db, now } = deps;
  const rows = await db.selectDistinct({ safeId: reserveRuns.safeId, chainId: reserveRuns.chainId })
    .from(reserveRuns)
    .leftJoin(safeNetworks, and(
      eq(safeNetworks.safeId, reserveRuns.safeId), eq(safeNetworks.chainId, reserveRuns.chainId), eq(safeNetworks.agentAdded, true),
    ))
    .where(and(eq(reserveRuns.status, "pending"), unwatchedRun(now), isNull(safeNetworks.safeId)));
  for (const row of rows) await reconcileReserveRuns(deps, row.safeId, row.chainId as ChainId, true);
}

/** The monitor hook (BP-41): never throws. Reconciles pending policy changes, retries unsent emails, then acts. */
export async function reserveOnSnapshot(deps: ExecutorDeps, input: { safeId: number; position: LoanPosition }): Promise<void> {
  const { db, log } = deps;
  try {
    await reconcilePolicyChanges(deps, input.safeId, input.position.chainId);
    const link = await loadReserveLink(db, input.safeId, input.position.chainId);
    if (!link) return;
    const settled = await reconcileRuns(deps, link, input.position);
    await retryEmails(deps, input.safeId);
    if (settled) return; // this snapshot was read before the repay landed: act on the next one
    await executeReserve(deps, { link, position: input.position, origin: "auto" });
  } catch (e) {
    log(`reserve: ${input.position.id} failed`, e);
  }
}

export const newNowKey = () => randomUUID();
