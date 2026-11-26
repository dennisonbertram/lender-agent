// Follow proposals to execution (BP-15, architecture 3.1 step 5). One refresh reads the transaction
// from the Transaction Service (confirmations, executed, success) and the Safe threshold from chain,
// stores them, and writes one Activity row per event (eventKey, so repeated polls write one each).
// On execution it confirms the receipt (real chain only), reads the new position from the lender and
// appends ONE chat message (id `done-<proposalId>`). Side effects come before the stage update and
// are all idempotent, so a crash in between is repaired by the next poll. No figure comes from the model.
import { and, eq, inArray } from "drizzle-orm";
import { getAddress, keccak256, toBytes, toEventSelector } from "viem";
import { centDigits, fmt, usd } from "@/lib/format";
import type { OpenSpec } from "@/lib/proposals";
import { recordActivity } from "@/server/activity";
import { recordSignatures } from "@/server/activity-view";
import { appendServerMessage } from "@/server/agent/persist";
import { getPublicClient } from "@/server/chain/client";
import type { Db } from "@/server/db/client";
import { proposals, reserveLinks, safes } from "@/server/db/schema";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { chainLenderReads, otherRefs } from "@/server/lenders/reads";
import { MORPHO_BLUE } from "@/server/lenders/allowlist";
import type { LenderId } from "@/server/lenders/types";
import { AAVE_VENUE_ID, AAVE_VENUE_NAME } from "@/server/market-inputs";
import { lenderOfSpec } from "@/server/proposals/lender-of";
import type { StoredCloseSpec } from "@/server/proposals/close";
import type { StoredRepaySpec } from "@/server/proposals/repay";
import { clearReserveCache } from "@/server/reserve/status";
import { chainExecDeps, mockExecDeps } from "@/server/proposals/exec-deps";
import { pendingExecOf, type PendingExec } from "@/server/proposals/pending";
import { reconcileAllSending } from "@/server/proposals/send";
import type { Services } from "@/server/services";
import type { Address, ChainId, Hex } from "@/shared/types";

type Row = typeof proposals.$inferSelect;

/**
 * Stages that are closed on our side but whose transaction can still be executed in Safe (deleting
 * does not revoke signatures). They are followed until the Safe nonce passes their own.
 */
const CLOSED_FOLLOWED = ["rejected", "stale", "stopped", "replaced"];
/**
 * The Transaction Service indexes executions with a delay. After the Safe nonce passes a closed
 * proposal's nonce, keep asking this long before concluding it never ran.
 */
export const NONCE_PASSED_GRACE_MS = 30 * 60 * 1000;
const FOLLOWED = ["queued", ...CLOSED_FOLLOWED];

const VENUE_NAMES: Record<string, string> = { [AAVE_VENUE_ID]: AAVE_VENUE_NAME, "compound-v3": "Compound v3", "morpho-blue": "Morpho" };

/** The lender's own health for the Safe's loan, read from that lender (never Aave's for another lender's loan). */
async function healthOf(services: Services, chainId: ChainId, safe: Address, lender: LenderId, spec?: { marketId?: string; collateral?: string }): Promise<number | null> {
  if (lender === AAVE_VENUE_ID) {
    const { position } = await services.reader.readAavePosition(chainId, safe);
    return position?.healthFactor ?? null;
  }
  const reads = services.lenders ?? chainLenderReads;
  const refs = otherRefs(chainId).filter((r) => r.lender === lender
    && (!spec?.marketId || r.marketId.toLowerCase() === spec.marketId.toLowerCase())
    && (!spec?.collateral || r.collateral.toLowerCase() === spec.collateral.toLowerCase()));
  const positions = await Promise.all(refs.map((r) => reads.position(r, safe)));
  return positions.find((p) => p && !p.mixed && p.health !== null && (!spec?.marketId || p.marketId.toLowerCase() === spec.marketId.toLowerCase()))?.health ?? null;
}

/** The lender's own debt figure for the Safe's loan, read from that lender (never Aave's for another lender's loan). */
async function debtOf(services: Services, chainId: ChainId, safe: Address, spec: StoredRepaySpec): Promise<number | null> {
  const lender = lenderOfSpec(spec);
  if (lender === AAVE_VENUE_ID) {
    const { position } = await services.reader.readAavePosition(chainId, safe);
    return position ? position.debt.filter((d) => d.asset === "USDC").reduce((s, d) => s + d.amount, 0) : null;
  }
  const reads = services.lenders ?? chainLenderReads;
  const refs = otherRefs(chainId).filter((r) => r.lender === lender
    && (!spec.marketId || r.marketId.toLowerCase() === spec.marketId.toLowerCase())
    && (!spec.collateral || r.collateral.toLowerCase() === spec.collateral.toLowerCase()));
  const positions = await Promise.all(refs.map((r) => reads.position(r, safe)));
  const own = positions.find((p) => p && !p.mixed && (!spec.marketId || p.marketId.toLowerCase() === spec.marketId.toLowerCase()));
  return own ? own.debt.filter((d) => d.asset === "USDC").reduce((s, d) => s + d.amount, 0) : null;
}

type RepayReceipt = { logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] };

/** The lender event, scoped to this Safe and the selected market, is the executed amount. */
export function repaidFromReceipt(row: Row, safe: Address, receipt: RepayReceipt | null): number | null {
  const spec = row.spec as StoredRepaySpec;
  if (spec.kind !== "repay" || !receipt) return null;
  const chainId = row.chainId as ChainId;
  const lender = lenderOfSpec(spec);
  const event = lender === AAVE_VENUE_ID
    ? { address: AAVE[chainId]?.pool, topic: toEventSelector("Repay(address,address,address,uint256,bool)"), market: tokenBySymbol(chainId, "USDC")?.address }
    : lender === "morpho-blue"
      ? { address: MORPHO_BLUE, topic: toEventSelector("Repay(bytes32,address,address,uint256,uint256)"), market: spec.marketId }
      : null;
  if (!event?.address || !event.market) return null;
  const log = receipt.logs.find((l) => l.address.toLowerCase() === event.address!.toLowerCase()
    && l.topics[0]?.toLowerCase() === event.topic.toLowerCase()
    && (lender === AAVE_VENUE_ID
      ? l.topics[1]?.toLowerCase() === `0x${"0".repeat(24)}${event.market!.slice(2).toLowerCase()}`
        && l.topics[2]?.toLowerCase() === `0x${"0".repeat(24)}${safe.slice(2).toLowerCase()}`
        && l.topics[3]?.toLowerCase() === `0x${"0".repeat(24)}${safe.slice(2).toLowerCase()}`
      : l.topics[1]?.toLowerCase() === event.market!.toLowerCase() && l.topics[3]?.toLowerCase() === `0x${"0".repeat(24)}${safe.slice(2).toLowerCase()}`));
  if (!log || log.data.length < 66) return null;
  return Number(BigInt(`0x${log.data.slice(2, 66)}`)) / 1_000_000;
}

async function doneText(services: Services, row: Row, safe: Address, receipt: RepayReceipt | null): Promise<string> {
  const chainId = row.chainId as ChainId;
  const spec = row.spec as OpenSpec | StoredCloseSpec | StoredRepaySpec | { kind: "reserve-setup"; dailyLimitUsd: number } | { kind: "reserve-off" };
  if (spec.kind === "reserve-off") return "Done. The permission to use the Reserve is removed on-chain.";
  if (spec.kind === "reserve-setup") return `Done. The Reserve is set up: the agent can repay your USDC debt on Aave from the Reserve Safe, up to ${usd(spec.dailyLimitUsd)} a day.`;
  const lender = lenderOfSpec(spec);
  let health = "";
  let stillOwed = "";
  try {
    const hf = await healthOf(services, chainId, safe, lender, spec.kind === "repay" ? spec : undefined);
    if (hf !== null && Number.isFinite(hf)) health = ` Health factor ${hf.toFixed(2)}.`;
  } catch {
    // the figure is optional: never guess it
  }
  if (spec.kind === "repay") {
    if (typeof spec.amount !== "number" || !Number.isFinite(spec.amount)) return `Done. Executed in Safe.${health}`;
    const actual = services.mock
      ? (row.testRun as { repaymentAmount?: number } | null)?.repaymentAmount ?? spec.amount
      : repaidFromReceipt(row, safe, receipt);
    try {
      const debt = await debtOf(services, chainId, safe, spec);
      if (debt !== null && Number.isFinite(debt)) stillOwed = ` About ${usd(debt, centDigits(debt))} USDC is still owed.`;
    } catch {
      // the figure is optional: never guess it
    }
    if (actual === null || !Number.isFinite(actual)) return `Done. Your repayment transaction ran on your ${spec.venue ?? VENUE_NAMES[lender] ?? "lender"} loan, but its applied amount could not be confirmed.${stillOwed}${health}`;
    return `Done. You repaid ${usd(actual, centDigits(actual))} USDC on your ${spec.venue ?? VENUE_NAMES[lender] ?? "lender"} loan.${stillOwed}${health}`;
  }
  if (spec.kind === "close") return `Done. Your ${spec.venue} loan is closed. You paid back ${usd(spec.repaid)} USDC and ${fmt(spec.returned, 2)} ${spec.collAsset} is back in the Safe.`;
  if (spec.kind === "open") return `Done. Your ${usd(spec.borrow)} ${VENUE_NAMES[lender] ?? "lender"} loan is open. ${usd(spec.borrow)} USDC is in your Safe.${health}`;
  return `Done. Executed in Safe.${health}`;
}


const EXECUTION_SUCCESS = keccak256(toBytes("ExecutionSuccess(bytes32,uint256)"));
const EXECUTION_FAILURE = keccak256(toBytes("ExecutionFailure(bytes32,uint256)"));

/**
 * Settle the "I sent the execution" marker from the receipt (the marker is a hint, never proof).
 * Returns what this Safe's receipt says about this safeTxHash: executed (ExecutionSuccess), failed (ExecutionFailure),
 * or null with the marker cleared when the transaction reverted, belongs to something else, or is still unknown after its grace.
 */
async function settlePendingExec(db: Db, services: Services, row: Row, safe: Address, hash: Hex): Promise<{ txHash: Hex; success: boolean } | null> {
  const pending = (row.testRun as { pendingExec?: PendingExec } | null)?.pendingExec;
  if (!pending || row.stage !== "queued") return null;
  const deps = services.execDeps ?? (services.mock ? mockExecDeps : chainExecDeps);
  const chainId = row.chainId as ChainId;
  const clear = async (lastAttempt?: Record<string, unknown>) => {
    const { pendingExec: _gone, ...rest } = (row.testRun ?? {}) as Record<string, unknown>;
    await db.update(proposals).set({ testRun: lastAttempt ? { ...rest, lastAttempt } : rest, updatedAt: new Date() })
      .where(and(eq(proposals.id, row.id), eq(proposals.stage, "queued")));
  };
  const receipt = await deps.getReceipt(chainId, pending.txHash).catch(() => null);
  if (!receipt) {
    // Not mined. A known transaction may still be waiting in the pool; an unknown one is dropped after its short grace.
    if (!pendingExecOf(row.testRun)) await clear();
    return null;
  }
  const mine = (topic: Hex) => receipt.logs.find((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === topic
    // Safe 1.4 indexes the hash (topic 1); Safe 1.3 puts it first in the data. Pick by layout so an indexed event never matches through its payment word.
    && (l.topics.length >= 2 ? l.topics[1]!.toLowerCase() : l.data.slice(0, 66).toLowerCase()) === hash.toLowerCase());
  if (receipt.status === "reverted") {
    await clear({ status: "failed", txHash: pending.txHash, at: new Date().toISOString(), reason: "The transaction reverted on-chain. Nothing in your Safe changed." });
    return null;
  }
  if (mine(EXECUTION_SUCCESS)) return { txHash: pending.txHash, success: true };
  if (mine(EXECUTION_FAILURE)) return { txHash: pending.txHash, success: false };
  await clear({ status: "failed", txHash: pending.txHash, at: new Date().toISOString(), reason: "That transaction did not execute this proposal." });
  return null;
}

/** Refresh one proposal from the Transaction Service and chain; returns true when its stage changed. */
export async function refreshProposal(db: Db, services: Services, proposalId: string): Promise<boolean> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!row || !FOLLOWED.includes(row.stage) || !row.safeTxHash) return false;
  const wasStage = row.stage;
  const closed = wasStage !== "queued";
  const chainId = row.chainId as ChainId;
  const hash = row.safeTxHash as Hex;
  const [safeRow] = await db.select().from(safes).where(eq(safes.id, row.safeId)).limit(1);
  const safe = getAddress(safeRow.address) as Address;

  const stx = await services.safeService(chainId).getMultisigTransaction(hash);
  if (closed && (!stx || !stx.isExecuted)) {
    // Agent removal sets deletedFromQueue itself after confirming deletion. A missing entry may
    // reflect index lag, so keep that reservation while the transaction can still execute.
    // After the nonce passes, keep following through the grace period for late execution indexing.
    const awaitingRemovalConfirmation = row.stopReason === "agent_removed" && !row.deletedFromQueue;
    const nonce = await services.reader.readSafeNonce(chainId, safe).catch(() => null);
    const passed = nonce !== null && row.nonce !== null && nonce > row.nonce;
    const stop = async (patch: Partial<Row> = {}) => {
      await db.update(proposals).set({ deletedFromQueue: true, ...patch, updatedAt: new Date() }).where(and(eq(proposals.id, proposalId), eq(proposals.stage, wasStage)));
    };
    if (!stx && nonce !== null && !passed && !awaitingRemovalConfirmation) {
      await stop();
    } else if (passed) {
      const testRun = (row.testRun ?? {}) as Record<string, unknown>;
      const since = typeof testRun.noncePassedAt === "string" ? Date.parse(testRun.noncePassedAt) : NaN;
      if (Number.isNaN(since)) {
        await db.update(proposals).set({ testRun: { ...testRun, noncePassedAt: new Date().toISOString() } }).where(and(eq(proposals.id, proposalId), eq(proposals.stage, wasStage)));
      } else if (Date.now() - since >= NONCE_PASSED_GRACE_MS) {
        await stop();
      }
    }
    return false;
  }
  const fromReceipt = !closed && !stx?.isExecuted ? await settlePendingExec(db, services, row, safe, hash) : null;
  if (!stx && !fromReceipt) return false;
  const threshold = (await services.reader.readSafeThreshold(chainId, safe).catch(() => null)) ?? row.threshold;
  const confirmations = stx ? stx.confirmations.map((c) => ({ owner: c.owner.toLowerCase(), submittedAt: c.submissionDate })) : row.confirmations;

  if (stx) {
    await recordSignatures(db, { safeId: row.safeId, chainId, proposalId, safeTxHash: hash, confirmations: stx.confirmations.map((c) => ({ owner: c.owner, submittedAt: c.submissionDate })), title: row.title });
    const changed = confirmations.length !== row.confirmations.length || threshold !== row.threshold;
    if (changed) {
      await db.update(proposals).set({ confirmations, threshold, updatedAt: new Date() }).where(and(eq(proposals.id, proposalId), eq(proposals.stage, wasStage)));
    }
  }
  if (!stx?.isExecuted && !fromReceipt) return false;

  // The Service's word, or this Safe's own event in the receipt of the reported transaction (the Service indexes late).
  const txHash = stx?.isExecuted ? stx.transactionHash : fromReceipt!.txHash;
  let success = stx?.isExecuted ? stx.isSuccessful === true : fromReceipt!.success;
  let executionReceipt: RepayReceipt | null = null;
  if (success && !services.mock) {
    if (!txHash) return false;
    const receipt = await getPublicClient(chainId).getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt) return false; // not visible yet: look again next poll
    success = receipt.status === "success";
    executionReceipt = receipt;
  }

  if (!success) {
    await recordActivity(db, {
      safeId: row.safeId, chainId, actor: "Agent", kind: "status", proposalId, eventKey: `stage:${proposalId}:failed`, txHash, safeTxHash: hash,
      text: `Failed in Safe: ${row.title}`, detail: "The transaction reverted. Nothing changed.",
    });
    const [u] = await db.update(proposals).set({ stage: "failed", executedTxHash: txHash, confirmations, threshold, updatedAt: new Date() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.stage, wasStage))).returning({ id: proposals.id });
    return !!u;
  }

  await recordActivity(db, {
    safeId: row.safeId, chainId, actor: "Agent", kind: "status", proposalId, eventKey: `stage:${proposalId}:executed`, txHash, safeTxHash: hash,
    text: `Executed in Safe: ${row.title}`,
  });
  // The Reserve setup runs on the Reserve Safe, but the owners talk to the agent in the main Safe's thread.
  const chatSafeId = (row.spec as { kind?: string }).kind === "reserve-setup"
    ? (await db.select({ id: reserveLinks.mainSafeId }).from(reserveLinks).where(eq(reserveLinks.setupProposalId, proposalId)).limit(1))[0]?.id ?? row.safeId
    : row.safeId;
  await appendServerMessage(db, chatSafeId, { id: `done-${proposalId}`, parts: [{ type: "text", text: await doneText(services, row, safe, executionReceipt) }] });
  const [u] = await db.update(proposals).set({ stage: "executed", executedTxHash: txHash, confirmations, threshold, updatedAt: new Date() })
    .where(and(eq(proposals.id, proposalId), eq(proposals.stage, wasStage))).returning({ id: proposals.id });
  // An executed setup is the link: promote it (a link the owners turned off stays off).
  if (u && (row.spec as { kind?: string }).kind === "reserve-setup") {
    await db.update(reserveLinks).set({ state: "linked", updatedAt: new Date() }).where(and(eq(reserveLinks.setupProposalId, proposalId), eq(reserveLinks.state, "pending")));
    clearReserveCache();
  }
  return !!u;
}

/** Refresh every open (queued or sending) proposal and every closed one still in the Safe queue; also reconciles "sending" records. */
export async function followOpenProposals(db: Db, services: Services): Promise<void> {
  await reconcileAllSending(db, services).catch((e) => console.error("[follow] reconcile failed", e));
  const queued = await db.select({ id: proposals.id }).from(proposals)
    .where(and(inArray(proposals.stage, FOLLOWED), eq(proposals.deletedFromQueue, false)));
  for (const { id } of queued) {
    try {
      await refreshProposal(db, services, id);
    } catch (e) {
      console.error(`[follow] refresh ${id} failed`, e);
    }
  }
}
