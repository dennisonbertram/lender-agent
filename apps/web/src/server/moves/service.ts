// The move's life (BP-36 to BP-38): draft from a plan with a real quote, send it as proposal 1 of 2, expire a stale quote and
// re-draft, follow the transfer, and on proven arrival draft the loan. State is the `moves` row; the proposal is the ordinary one.
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getAddress } from "viem";
import { fmt, usd } from "@/lib/format";
import { compute, type OpenSpec, type Spec } from "@/lib/proposals";
import type { Asset } from "@/lib/types";
import { recordActivity } from "@/server/activity";
import { assertAgentActive } from "@/server/agent-role";
import { appendServerMessage } from "@/server/agent/persist";
import { requireNetwork } from "@/server/auth/access";
import type { Db } from "@/server/db/client";
import { moves, proposals, safes } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { deleteIfUnconfirmed } from "@/server/proposals/reject";
import { deliver, resultOf, SendBlocked, withNextProposalNonce, type SendResult } from "@/server/proposals/send";
import type { SafeContext } from "@/server/request";
import { safeTxHash } from "@/server/safe/hash";
import { buildSafeTx } from "@/server/safe/multisend";
import type { Services } from "@/server/services";
import { isChainId, type Address, type ChainId, type Hex } from "@/shared/types";
import { followTransfer, type DestinationChain } from "./arrival";
import { arrivedLine, delayedLine, failedLine, moveFeesLine, noLoanYet, noRedraftLine, partialLine, redraftedLine, refundedLine, revertedLine } from "./copy";
import { getMoveDeps, type MoveDeps } from "./deps";
import { isMoveStale, moveExpiry, OUT_OF_DATE_LINE } from "./expiry";
import { buildMoveBatch, checkMoveBatch, checkMoveQuote } from "./invariants";
import { chainName, MOVE_NETWORKS } from "./networks";
import { liveDestinationOwners, ownsSafe, plannedDestinationOwners } from "./ownership";
import { moveRequestForStoredSpec, quoteAnswersMoveRequest } from "./gate";
import type { CrossNetworkPlan } from "./plan";
import { fromRaw, moveToken } from "./tokens";
import { quoteFromJson, quoteToJson, type AggregatorQuote } from "./types";

export type MoveRow = typeof moves.$inferSelect;
/** The stored plan: the library's move spec plus the sentences shown with it. */
export type StoredMoveSpec = Extract<Spec, { kind: "move" }> & { reason?: string | null; feesLine?: string };

const lc = (a: string) => a.toLowerCase();
const OPEN_STATUSES = ["quoted", "queued"];

const inputsFor = () => ({ prices: { ETH: 0, wstETH: 0, WBTC: 0, DAI: 1, USDC: 1 }, venues: [], networks: MOVE_NETWORKS, feeEstimateUsd: 0 });
/** Title, steps and outcome as the library words them (the mockup's wording is final). */
const words = (spec: Spec) => compute(spec, [], inputsFor());

/** Draft a move from a plan that has a quote. Nothing is sent: the owner presses "Send move to Safe (step 1 of 2)". */
export async function draftMove(db: Db, p: { safeId: number; safeAddress: Address; plan: CrossNetworkPlan; now: Date; wallet: Address; destination: DestinationChain }): Promise<MoveRow> {
  const { plan } = p;
  const move = plan.choice.plan.move;
  if (!move || !plan.quote || !plan.then) throw new HttpError(409, "This plan has no move.");
  const checked = checkMoveQuote(plan.quote, { safe: p.safeAddress, fromChain: plan.quote.fromChain, toChain: plan.quote.toChain });
  if (!checked.ok) throw new HttpError(422, `This move is not safe to send: ${checked.reason}.`);
  // The Safe at this address on the destination must answer to this wallet too: its live owners when deployed, else its setup's.
  const destOwners = await plannedDestinationOwners(db, p.destination, { safeId: p.safeId, chainId: plan.quote.toChain, safe: p.safeAddress });
  if (!ownsSafe(destOwners, p.wallet)) throw new HttpError(403, `You are not an owner of this Safe on ${chainName(plan.quote.toChain)}.`);
  const spec: StoredMoveSpec = { kind: "move", safeId: lc(p.safeAddress), move, then: plan.then, reason: plan.reason, feesLine: moveFeesLine(move.feeUsd) };
  return insertMove(db, { safeId: p.safeId, quote: plan.quote, spec, asset: move.asset });
}

async function insertMove(db: Db, p: { safeId: number; quote: AggregatorQuote; spec: StoredMoveSpec; asset: Asset }): Promise<MoveRow> {
  const [row] = await db.insert(moves).values({
    id: randomUUID(), safeId: p.safeId, fromChain: p.quote.fromChain, toChain: p.quote.toChain, asset: p.asset, status: "quoted",
    quote: quoteToJson(p.quote), spec: p.spec, quotedAt: new Date(p.quote.quotedAt), expiresAt: moveExpiry(p.quote.quotedAt, p.quote.tool),
  }).returning();
  return row!;
}

export type MoveView = {
  id: string;
  status: string;
  title: string;
  /** "Move 2.04 ETH from Base to Ethereum (about 10 minutes)." */
  moveLine: string;
  reason: string | null;
  feesLine: string | null;
  outcome: string;
  steps: string[];
  expiresAt: string;
  /** The quote ran out: the card reads "Out of date". */
  outOfDate: boolean;
  /** The sentence under the card. */
  sentence: string;
  canSend: boolean;
  proposalId: string | null;
  replacedBy: string | null;
};

const statusSentence: Record<string, string> = {
  quoted: "Drafted, not yet sent to Safe.",
  queued: "In your Safe queue. Sign it there, then the move starts.",
  bridging: "Signed and sent. Waiting for it to arrive.",
  arrived: "Arrived. Step 2: sign the loan below.",
  partial: "Only partly completed. See the message above.",
  refunded: "Refunded. The funds are back on the source network.",
  failed: "It failed. See the message above.",
  closed: "Stopped. Nothing moved.",
};

export function moveView(row: MoveRow, now: Date): MoveView {
  const spec = row.spec as StoredMoveSpec;
  const text = words(spec);
  const m = spec.move;
  const outOfDate = row.status === "expired" || (OPEN_STATUSES.includes(row.status) && isMoveStale(row.expiresAt, now));
  return {
    id: row.id, status: outOfDate ? "expired" : row.status, title: text.title,
    moveLine: `Move ${fmt(m.amount, 2)} ${m.asset} from ${chainName(row.fromChain)} to ${chainName(row.toChain)} (about ${m.minutes} minutes).`,
    reason: spec.reason ?? null, feesLine: spec.feesLine ?? null, outcome: text.outcome, steps: text.steps,
    expiresAt: row.expiresAt.toISOString(), outOfDate,
    sentence: outOfDate ? OUT_OF_DATE_LINE : statusSentence[row.status] ?? "",
    canSend: row.status === "quoted" && !outOfDate, proposalId: row.proposalId, replacedBy: row.replacedBy,
  };
}

export async function getMove(db: Db, safeId: number, id: string): Promise<MoveRow> {
  const [row] = await db.select().from(moves).where(and(eq(moves.id, id), eq(moves.safeId, safeId))).limit(1);
  if (!row) throw new HttpError(404, "Move not found");
  return row;
}

type Ctx = Pick<SafeContext, "db" | "services" | "safe" | "wallet" | "access">;

/**
 * "Send move to Safe (step 1 of 2)" (BP-37). The Safe is set up on the destination first; the quote must still be good; the
 * calldata must pay the same Safe; the simulation must pass. Only then is the record stored, as "sending", and delivered like any proposal.
 */
export async function sendMove(ctx: Ctx, moveId: string, deps: MoveDeps = getMoveDeps(ctx.services)): Promise<SendResult & { moveId: string }> {
  const { db, services, safe } = ctx;
  const row = await getMove(db, safe.id, moveId);
  const from = row.fromChain;
  if (!isChainId(from)) throw new HttpError(400, "Moves can only start on a network this Safe's agent works on.");
  requireNetwork(ctx.access, from);
  const safeAddress = getAddress(safe.address) as Address;
  await assertAgentActive(services, from, safeAddress);

  const blocked = (reason: string) => new SendBlocked(reason, `${reason} Nothing was sent.`);
  // The destination Safe must still be this wallet's: live owners, never a stored answer. A first send passes this before storing.
  const checkDestinationOwners = async () => {
    const owners = await liveDestinationOwners(deps.destination, row.toChain, safeAddress);
    if (!ownsSafe(owners, ctx.wallet)) {
      throw blocked(owners === null ? `I could not confirm who owns this Safe on ${chainName(row.toChain)}.` : `This Safe on ${chainName(row.toChain)} is owned by a different wallet.`);
    }
  };
  if (row.proposalId) { // a second press: the same proposal
    const [existing] = await db.select().from(proposals).where(eq(proposals.id, row.proposalId)).limit(1);
    if (existing) {
      if (existing.stage !== "sending") return { ...resultOf(existing), moveId };
      // The same settle path the worker's reconcile runs: the service's own answer first, then the gate —
      // a refusal ends the record "not_sent" instead of holding its nonce "sending" forever.
      const delivered = await deliver(db, services, existing, safeAddress);
      if (delivered.stage === "not_sent") throw blocked(delivered.stopReason ?? "This move was not sent.");
      return { ...resultOf(delivered), moveId };
    }
  }
  if (row.status !== "quoted") throw blocked(row.status === "expired" ? OUT_OF_DATE_LINE : "This move is no longer a draft.");
  const now = deps.now();
  if (isMoveStale(row.expiresAt, now)) {
    await expireMove(db, services, deps, row, now);
    throw blocked(OUT_OF_DATE_LINE);
  }

  const quote = quoteFromJson(row.quote);
  const spec = row.spec as StoredMoveSpec;
  // Reject legacy or tampered drafts before destination setup can spend sponsorship or relayer funds.
  const request = moveRequestForStoredSpec({
    spec, rowSafeId: safe.id, moveSafeId: row.safeId, chainId: from,
    fromChain: row.fromChain, toChain: row.toChain, asset: row.asset, safe: safeAddress,
  });
  if (!request || !quoteAnswersMoveRequest(quote, request)) throw blocked("The stored quote does not match the requested move.");
  const checked = checkMoveQuote(quote, { safe: safeAddress, fromChain: row.fromChain, toChain: row.toChain });
  if (!checked.ok) throw blocked(`Test run failed: ${checked.reason}.`);

  // The Safe must exist on the destination before the funds go there (R-10).
  const setup = await deps.setupSafe(db, row.toChain, safeAddress);
  if (!setup.ok) throw blocked(setup.reason);

  const calls = buildMoveBatch(quote);
  const sim = await deps.simulate({ chainId: from, safe: safeAddress, calls });
  if (!sim.ok) throw blocked(`The test run failed${sim.failedStep !== undefined ? ` at step ${sim.failedStep + 1}` : ""}.`);

  const onChainNonce = (await services.reader.readSafeNonce(from, safeAddress)) ?? 0n;
  const text = words(spec);
  const threshold = await services.reader.readSafeThreshold(from, safeAddress);
  const key = createHash("sha256").update(`move:${row.id}`).digest("hex");
  const feeUsd = sim.feeUsd + spec.move.feeUsd;
  const line = `Checked: this would work. Network fee about ${usd(sim.feeUsd, sim.feeUsd < 1 ? 2 : 0)}, and about ${usd(Math.round(spec.move.feeUsd))} for the bridge.`;
  // ... and it must be this wallet's Safe there: re-read the live owners now, never the draft's answer, as late as possible before it is sent.
  await checkDestinationOwners();
  // Reconciliation must see the sending proposal and its move link in the same commit.
  const stored = await withNextProposalNonce(db, safe.id, from, onChainNonce, async (txn, nonce) => {
    const [current] = await txn.select({ status: moves.status, proposalId: moves.proposalId }).from(moves)
      .where(and(eq(moves.id, row.id), eq(moves.safeId, safe.id))).for("update").limit(1);
    if (!current) throw new HttpError(404, "Move not found");
    if (current.proposalId) {
      const [existing] = await txn.select().from(proposals).where(eq(proposals.id, current.proposalId)).limit(1);
      if (existing) return existing;
    }
    if (current.status !== "quoted") throw blocked(current.status === "expired" ? OUT_OF_DATE_LINE : "This move is no longer a draft.");

    const tx = buildSafeTx(calls, nonce);
    const inv = checkMoveBatch(quote, { safe: safeAddress, fromChain: row.fromChain, toChain: row.toChain, calls, outer: tx });
    if (!inv.ok) throw blocked(`Test run failed: ${inv.reason}.`);
    const hash = safeTxHash(from, safeAddress, tx);

    const [inserted] = await txn.insert(proposals).values({
      id: randomUUID(), safeId: safe.id, chainId: from, spec, tx, nonce, safeTxHash: hash, idempotencyKey: key,
      title: text.title, steps: text.steps, outcome: text.outcome, stage: "sending", threshold,
      testRun: { ok: true, feeUsd, healthAfter: null, reason: null, line }, createdBy: ctx.wallet.toLowerCase(),
    }).onConflictDoNothing({ target: proposals.idempotencyKey }).returning();
    const proposal = inserted ?? (await txn.select().from(proposals).where(eq(proposals.idempotencyKey, key)).limit(1))[0]!;
    await txn.update(moves).set({ proposalId: proposal.id, status: "queued", updatedAt: now }).where(eq(moves.id, row.id));
    return proposal;
  });
  const delivered = stored.stage === "sending" ? await deliver(db, services, stored, safeAddress) : stored;
  const result = resultOf(delivered);
  return { ...result, receipt: delivered.stage === "queued" ? `Sent to your Safe: ${text.title} (step 1 of 2).` : result.receipt, moveId };
}

async function say(db: Db, safeId: number, chainId: number, id: string, text: string, parts: { type: string; [k: string]: unknown }[] = [], opts: { proposalId?: string | null; detail?: string } = {}) {
  await recordActivity(db, { safeId, chainId: isChainId(chainId) ? chainId : null, actor: "Agent", kind: "status", text, eventKey: `move:${id}`, proposalId: opts.proposalId ?? null, detail: opts.detail ?? null });
  await appendServerMessage(db, safeId, { id: `move-${id}`, parts: [{ type: "text", text }, ...parts] as never });
}

/**
 * The quote ran out (D-13): the card reads "Out of date", a proposal still in the Safe queue is deleted from it (when nobody has
 * signed it), and the agent offers a fresh draft from a new quote for the same pair and amount.
 */
export async function expireMove(db: Db, services: Services, deps: MoveDeps, row: MoveRow, now: Date): Promise<MoveRow | null> {
  if (!OPEN_STATUSES.includes(row.status)) return null;
  const quote = quoteFromJson(row.quote);
  const spec = row.spec as StoredMoveSpec;
  let deletedNote = "";
  if (row.proposalId) {
    const [p] = await db.select().from(proposals).where(eq(proposals.id, row.proposalId)).limit(1);
    if (p && p.stage === "sending") return null; // outcome unknown: the sender settles it first
    if (p && !["queued", "draft"].includes(p.stage)) return null; // executed (or otherwise settled): the follower owns it; expiry is for unexecuted proposals
    if (p && ["queued", "draft"].includes(p.stage)) {
      const chainId = p.chainId as ChainId;
      if (p.safeTxHash) {
        const live = await services.safeService(chainId).getMultisigTransaction(p.safeTxHash as Hex).catch(() => null);
        if (live?.isExecuted) return null; // it ran: the follower settles it, the quote no longer matters
      }
      const deleted = !p.safeTxHash || (await deleteIfUnconfirmed({ services } as SafeContext, p.id, chainId, p.safeTxHash as Hex, p.confirmations.length > 0).catch(() => false));
      await db.update(proposals).set({ stage: "stale", deletedFromQueue: deleted, updatedAt: now }).where(and(eq(proposals.id, p.id), inArray(proposals.stage, ["queued", "draft"])));
      await recordActivity(db, { safeId: row.safeId, chainId, actor: "Agent", kind: "status", proposalId: p.id, eventKey: `stale:${p.id}`, text: `"${p.title}" is out of date: the quote ran out.${deleted ? " It is no longer in your Safe queue." : " It is still in your Safe queue. Reject it in Safe too."}` });
      deletedNote = deleted ? "" : " It is still in your Safe queue: reject it in Safe too.";
    }
  }
  const [claimed] = await db.update(moves).set({ status: "expired", updatedAt: now }).where(and(eq(moves.id, row.id), inArray(moves.status, OPEN_STATUSES))).returning();
  if (!claimed) return null;

  const [safeRow] = await db.select().from(safes).where(eq(safes.id, row.safeId)).limit(1);
  const safe = getAddress(safeRow!.address) as Address;
  const req = moveRequestForStoredSpec({
    spec, rowSafeId: row.safeId, moveSafeId: row.safeId, chainId: row.fromChain,
    fromChain: row.fromChain, toChain: row.toChain, asset: row.asset, safe,
  });
  // Existing rows can predate today's checks. A fresh quote is allowed only when the stored route still
  // matches the original request; never use the stored quote itself as the authority for a replacement.
  if (!req || !quoteAnswersMoveRequest(quote, req) || !checkMoveQuote(quote, { safe, fromChain: row.fromChain, toChain: row.toChain }).ok) {
    await say(db, row.safeId, row.fromChain, `redraft-${row.id}`, noRedraftLine(row.toChain) + deletedNote);
    return null;
  }
  const fresh = await deps.aggregator.quote(req).catch(() => null);
  if (!fresh || !quoteAnswersMoveRequest(fresh, req) || !checkMoveQuote(fresh, { safe, fromChain: row.fromChain, toChain: row.toChain }).ok) {
    await say(db, row.safeId, row.fromChain, `redraft-${row.id}`, noRedraftLine(row.toChain) + deletedNote);
    return null;
  }
  const dst = moveToken(row.asset as Asset, row.toChain);
  const arrives = fromRaw(fresh.toAmountMin, dst?.decimals ?? fresh.toDecimals);
  const next: StoredMoveSpec = {
    ...spec,
    move: { ...spec.move, feeUsd: fresh.feeUsd, minutes: Math.max(1, Math.ceil(fresh.durationSec / 60)) },
    then: { ...spec.then, amount: Math.min(spec.then.amount, arrives) } as OpenSpec,
    feesLine: moveFeesLine(fresh.feeUsd),
  };
  const draft = await insertMove(db, { safeId: row.safeId, quote: { ...fresh, quotedAt: deps.now().getTime() }, spec: next, asset: row.asset as Asset });
  await db.update(moves).set({ replacedBy: draft.id }).where(eq(moves.id, row.id));
  await say(db, row.safeId, row.fromChain, `redraft-${row.id}`, redraftedLine(row.toChain) + deletedNote, [{ type: "data-move", data: { moveId: draft.id } }]);
  return draft;
}

const amountText = (row: MoveRow) => fmt(fromRaw(BigInt(quoteFromJson(row.quote).fromAmount), quoteFromJson(row.quote).fromDecimals), 2);

/** One pass over open moves: expire, follow the proposal, follow the transfer (BP-37, BP-38). Safe to run twice. */
export async function runMovesTick(db: Db, services: Services, deps: MoveDeps = getMoveDeps(services)): Promise<void> {
  const now = deps.now();
  const open = await db.select().from(moves).where(inArray(moves.status, ["quoted", "queued", "bridging"]));
  for (const row of open) {
    try {
      // Execution is settled before expiry: a proposal that already ran is never marked expired.
      if (row.status === "queued") await followProposal(db, row, now);
      const [cur] = await db.select().from(moves).where(eq(moves.id, row.id)).limit(1);
      if (cur && OPEN_STATUSES.includes(cur.status) && isMoveStale(cur.expiresAt, now)) await expireMove(db, services, deps, cur, now);
      else if (row.status === "bridging") await followBridge(db, services, deps, row, now);
    } catch (e) {
      console.error(`[moves] ${row.id} failed`, e);
    }
  }
}

/** The proposal ran in Safe (the transfer starts), or it stopped without running (nothing moved). */
async function followProposal(db: Db, row: MoveRow, now: Date): Promise<void> {
  if (!row.proposalId) return;
  const [p] = await db.select().from(proposals).where(eq(proposals.id, row.proposalId)).limit(1);
  if (!p) return;
  if (p.stage === "executed" && p.executedTxHash) {
    await db.update(moves).set({ status: "bridging", sourceTxHash: p.executedTxHash, sentAt: now, updatedAt: now }).where(and(eq(moves.id, row.id), eq(moves.status, "queued")));
  } else if (p.stage === "failed") {
    const [u] = await db.update(moves).set({ status: "failed", detail: "reverted", updatedAt: now }).where(and(eq(moves.id, row.id), eq(moves.status, "queued"))).returning();
    if (u) await say(db, row.safeId, row.fromChain, `reverted-${row.id}`, revertedLine(amountText(row), row.asset as Asset, row.fromChain), [], { proposalId: p.id });
  } else if (["rejected", "stale", "replaced", "stopped", "not_sent"].includes(p.stage)) {
    await db.update(moves).set({ status: "closed", updatedAt: now }).where(and(eq(moves.id, row.id), eq(moves.status, "queued")));
  }
}

async function followBridge(db: Db, services: Services, deps: MoveDeps, row: MoveRow, now: Date): Promise<void> {
  if (!row.sourceTxHash || !row.sentAt) return;
  const [safeRow] = await db.select().from(safes).where(eq(safes.id, row.safeId)).limit(1);
  const safe = getAddress(safeRow!.address) as Address;
  const quote = quoteFromJson(row.quote);
  const spec = row.spec as StoredMoveSpec;
  const source = row.sourceTxHash as Hex;
  const asset = row.asset as Asset;
  const done = (status: string, patch: Partial<MoveRow> = {}) => db.update(moves).set({ status, updatedAt: now, ...patch }).where(and(eq(moves.id, row.id), eq(moves.status, "bridging")));

  const outcome = await followTransfer({ aggregator: deps.aggregator, chain: deps.destination }, {
    safe, fromChain: row.fromChain, toChain: row.toChain, sourceTxHash: source, token: quote.toToken, durationSec: quote.durationSec, sentAt: row.sentAt.getTime(),
  }, now);

  switch (outcome.kind) {
    case "pending": case "unconfirmed": return;
    case "delayed":
      if (row.delayedAt) return;
      await db.update(moves).set({ delayedAt: now }).where(and(eq(moves.id, row.id), eq(moves.status, "bridging")));
      return say(db, row.safeId, row.fromChain, `delayed-${row.id}`, delayedLine(row.toChain, spec.move.minutes, source));
    case "partial":
      await say(db, row.safeId, row.fromChain, `partial-${row.id}`, partialLine(amountText(row), asset, row.fromChain, row.toChain, source), [], { detail: outcome.message });
      await done("partial", { detail: outcome.message ?? null, arrivedAt: now });
      return;
    case "refunded":
      await say(db, row.safeId, row.fromChain, `refunded-${row.id}`, refundedLine(amountText(row), asset, row.fromChain, row.toChain, source), [], { detail: outcome.message });
      await done("refunded", { detail: outcome.message ?? null, arrivedAt: now });
      return;
    case "failed":
      await say(db, row.safeId, row.fromChain, `failed-${row.id}`, failedLine(amountText(row), asset, row.fromChain, row.toChain, source), [], { detail: outcome.message });
      await done("failed", { detail: outcome.message ?? null, arrivedAt: now });
      return;
    case "arrived": {
      // The message is written first and idempotent (its id), so a crash before the status update repeats it harmlessly.
      const units = fromRaw(outcome.amountRaw, moveToken(asset, row.toChain)?.decimals ?? quote.toDecimals);
      const messageId = `move-arrived-${row.id}`;
      const parts = await deps.draftLoan({ db, services, safeId: row.safeId, safeAddress: safe }, { then: spec.then, arrivedUnits: units, messageId });
      const text = arrivedLine(units, asset, row.toChain, spec.then.amount) + (parts.length === 0 ? ` ${noLoanYet(row.toChain)}` : "");
      await recordActivity(db, { safeId: row.safeId, chainId: isChainId(row.fromChain) ? row.fromChain : null, actor: "Agent", kind: "status", eventKey: `move:arrived-${row.id}`, text: `Your ${fmt(units, 2)} ${asset} arrived on ${chainName(row.toChain)}.`, detail: `Destination transaction on ${chainName(row.toChain)} (chain ${row.toChain}): ${outcome.destTxHash}.` });
      await appendServerMessage(db, row.safeId, { id: messageId, parts: [{ type: "text", text }, ...parts] as never });
      await done("arrived", { receivedRaw: outcome.amountRaw.toString(), destTxHash: outcome.destTxHash, arrivedAt: now });
      return;
    }
  }
}

