// What a stored proposal looks like to a viewer (BP-28): the same summary for the owner and the
// co-signer. Pure; no database. The hash is recomputed from the stored transaction.
import { centDigits, fmt, usd } from "@/lib/format";
import { STILL_QUEUED } from "@/lib/activity-copy";
import { stoppedLine } from "@/lib/proposals";
import { segmentState, type SegmentState } from "@/lib/step-bar";
import { safeQueueLink, safeTxLink } from "@/server/safe/links";
import { safeTxHash } from "@/server/safe/hash";
import { callsOf, type ProposalCall } from "@/server/proposals/calls";
import { pendingExecOf } from "@/server/proposals/pending";
import type { proposals } from "@/server/db/schema";
import type { Address, ChainId, Hex, ProposalStage, SafeTx } from "@/shared/types";

export type ProposalRow = typeof proposals.$inferSelect;

export type ProposalView = {
  id: string;
  chainId: ChainId;
  title: string;
  steps: string[];
  outcome: string;
  stage: ProposalStage;
  /** One segment per required signature, then the run. All "todo" for a draft or a stopped proposal. */
  segments: SegmentState[];
  sentence: string;
  /** "1 of 2 signed" / "All signed", shown beside the bar; absent for drafts and finished proposals. */
  countLabel?: string;
  /** The sentence that replaces `sentence` once executed: what the person now has. */
  doneLine?: string;
  needsSignatures: number;
  signedCount: number;
  links: { tx: string | null; queue: string };
  /** Show "Open in Safe": it is (or was, or still is) in the Safe queue. */
  inSafe: boolean;
  /** Whether the Safe nonce is known to have moved past this proposal's nonce. Null means unreadable or unavailable. */
  noncePassed: boolean | null;
  /** Recomputed from the stored transaction; null when no transaction is stored yet. */
  safeTxHash: Hex | null;
  /** True when the stored column differs from the recomputed hash. Never show the stored one then. */
  hashMismatch: boolean;
  nonce: string | null;
  testRunLine?: string;
  stillQueuedNote?: string;
  /** The viewer already confirmed it in Safe. */
  viewerSigned: boolean;
  /** No more changes will happen: the client stops polling. */
  final: boolean;
  createdAt: string;
  /** An open loan proposal that has not run: an edit can replace it (BP-24). */
  editable?: boolean;
  /** A close's signing deadline (ISO): its approval covers interest only until then. */
  signBy?: string;
  /** What to do next, only while queued (absent on a hash mismatch: the alert stands alone). */
  nextStep?: string;
  /** The spec kind: open, move, protect, close, reserve-setup, reserve-off, … */
  specKind: string;
  /** The loan this proposal opens, protects or closes (the id format of server/loans.ts). */
  loanId?: string;
  /** The hash of the transaction that executed it on chain (stored when the Transaction Service reported it). */
  executionTxHash?: Hex;
  /** When it was recorded as executed or failed (ISO). */
  executedAt?: string;
  /** Who approved, from the stored confirmations (kept after the run, unlike `owners`). */
  approvals?: { address: Address; at: string; isYou: boolean }[];
  /** Every call the transaction makes, decoded from the stored transaction (a batch is unpacked). */
  calls: ProposalCall[];
  /** The safety level chosen for a new loan, when the stored spec has it. */
  safety?: "Extra safe" | "Balanced" | "Lean";
  /** The contract the Safe transaction calls (the MultiSend for a batch). */
  target?: Address;
  /** The proposal that replaced this one. */
  replacedBy?: string;
  /** Current owners (live chain read) and whether each signed. Only on a queued proposal whose owners could be read. */
  owners?: { address: Address; signed: boolean; isYou: boolean }[];
  threshold?: number;
  /** The viewer is a current owner, has not signed, and nothing stops them. */
  canSign?: boolean;
  /** The viewer is a current owner and the transaction can run now (threshold met, or one short and they are the missing owner). */
  canSend?: boolean;
  state?: SignState | null;
  /** Why it failed (state "failed"). */
  failedReason?: string;
  /** Earlier-nonce proposals of ours it waits behind (state "blocked"). */
  blockedBy?: { id: string; nonce: string; title: string }[];
  /** Hash of the execution the owner's wallet sent, while it is being indexed. */
  pendingTxHash?: Hex;
  /** The money and the terms, computed from the stored plan (never from chat text). */
  facts?: ProposalFacts;
};

export type ProposalFacts = {
  sentence: string;
  changes: { label: string; hint?: string; amount: string; tone: "in" | "out" }[];
  terms: { label: string; value: string; hint?: string }[];
  /** The three numbers on the chat card: value and label. */
  numbers?: { value: string; label: string }[];
  /** One plain line on how safe the loan is afterwards. */
  healthLine?: string;
};

const LENDER_NAMES: Record<string, string> = { "aave-v3": "Aave v3", "morpho-blue": "Morpho", "compound-v3": "Compound" };
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** What the plan does to the Safe, from the stored spec; the interest and liquidation figures are read from the stored outcome text. */
export function factsOf(spec: Record<string, unknown>, outcome: string): ProposalFacts | undefined {
  const kind = spec.kind;
  const num = (n: unknown) => fmt(Number(n), Number(n) % 1 ? 2 : 0);
  if (kind === "open") {
    const lender = LENDER_NAMES[String(spec.venueId)] ?? String(spec.venueId);
    const asset = String(spec.asset);
    const apr = /at ([\d.]+)%/.exec(outcome)?.[1];
    const yearly = /Interest per year[^:]*: (\$[\d,]+)/.exec(outcome)?.[1];
    const liqAt = /falls to about (\$[\d,]+)/.exec(outcome)?.[1] ?? /falls below (\$[\d,]+)/.exec(outcome)?.[1];
    const terms: ProposalFacts["terms"] = [{ label: "Lender", value: lender }, { label: "Network", value: cap(String(spec.network)) }];
    if (apr) terms.push({ label: "Interest per year", value: `${apr}%${yearly ? ` · about ${yearly}` : ""}`, hint: "can change" });
    if (liqAt) terms.push({ label: "Liquidation price", value: `${liqAt} per ${asset}`, hint: `below this, ${lender} sells some of your ${asset} to repay` });
    return {
      sentence: `You'll borrow ${num(spec.borrow)} USDC from ${lender} and lock ${num(spec.amount)} ${asset} as collateral.`,
      changes: [
        { label: "You receive", hint: "USDC, a dollar-priced coin", amount: `+${num(spec.borrow)} USDC`, tone: "in" },
        { label: "You lock up", hint: `Held by ${lender} until you repay`, amount: `−${num(spec.amount)} ${asset}`, tone: "out" },
      ],
      terms,
      numbers: [{ value: `${num(spec.borrow)} USDC`, label: "You get" }, { value: `${num(spec.amount)} ${asset}`, label: "You lock" }, ...(yearly ? [{ value: `${yearly}/yr`, label: "Interest" }] : [])],
      healthLine: liqAt ? "The lender could sell some of this collateral if its price falls below the liquidation price shown above." : undefined,
    };
  }
  if (kind === "repay") {
    // A row stored before the repay fields existed (or a hand-written spec) still renders honestly:
    // the amount comes straight from the spec, the venue falls back to the loan id's lender name.
    if (typeof spec.amount !== "number" || !Number.isFinite(spec.amount)) return { sentence: outcome, changes: [], terms: [] };
    const venue = String(spec.venue ?? LENDER_NAMES[String(spec.loanId ?? "").split(":")[2]] ?? "your lender");
    const amount = num(spec.amount);
    const owed = typeof spec.owed === "number" && Number.isFinite(spec.owed) ? num(spec.owed) : undefined;
    const remaining = typeof spec.owed === "number" && Number.isFinite(spec.owed) ? num(Math.max(0, spec.owed - spec.amount)) : undefined;
    return {
      sentence: `You repay ${amount} USDC on your ${venue} loan from the Safe's USDC.${remaining ? ` About ${remaining} USDC stays owed.` : ""} Your collateral stays locked.`,
      changes: [{ label: "Requested repayment", hint: "USDC from the Safe", amount: `−${amount} USDC`, tone: "out" }],
      terms: [
        { label: "Lender", value: venue },
        ...(owed ? [{ label: "Debt when proposed", value: `${owed} USDC`, hint: "the lender balance can change before execution" }] : []),
        ...(remaining ? [{ label: "Estimated after repayment", value: `about ${remaining} USDC`, hint: "estimate at proposal time; interest keeps accruing" }] : []),
        { label: "Collateral", value: "Stays locked" },
      ],
      numbers: [{ value: `${amount} USDC`, label: "Requested repayment" }, ...(remaining ? [{ value: `${remaining} USDC`, label: "Estimated still owed" }] : [])],
    };
  }
  return { sentence: outcome, changes: [], terms: [] };
}

/** Where a proposal is for the person looking at it. null for a draft (nothing to sign yet). */
export type SignState =
  | "needs_your_signature"
  | "waiting_for_others"
  | "ready_to_send"
  | "sending"
  | "executed"
  | "failed"
  | "blocked"
  | "out_of_date"
  /** Queued, but the Safe's nonce moved past it: most likely it just ran and the follower has not recorded it yet. */
  | "settling"
  | "rejected";

/** What the caller read from chain (live) for a queued proposal; absent or null fields mean "could not read". */
export type ChainFacts = {
  owners: Address[] | null;
  nonce: bigint | null;
  /** Open proposals of ours with a lower nonce than this one (not yet run). */
  blockedBy?: { id: string; nonce: string; title: string }[];
};

export const OPEN_STAGES: ProposalStage[] = ["draft", "sending", "queued"];
export const isFinalStage = (s: ProposalStage) => !OPEN_STAGES.includes(s);

type StageInput = Pick<ProposalRow, "stage" | "confirmations">;

/** Which bar segment is current (the signature count while queued; the run once all signed), or -1 when stopped. */
export function stageOf(row: StageInput, threshold: number): { index: number; segments: SegmentState[] } {
  const signed = row.confirmations.length;
  const stage = row.stage as ProposalStage;
  const count = Math.max(1, threshold) + 1;
  let index: number;
  if (stage === "draft" || stage === "sending") index = 0;
  else if (stage === "queued") index = Math.min(signed, count - 1);
  else if (stage === "executed") index = count;
  else index = -1;
  const lit = stage === "queued" || stage === "executed";
  const segments = Array.from({ length: count }, (_, i) => (lit ? segmentState(i, index, index === count) : "todo"));
  return { index, segments };
}

const sig = (n: number) => `${n} signature${n === 1 ? "" : "s"}`;

function sentenceOf(row: ProposalRow, threshold: number, queued: boolean): string {
  const signed = row.confirmations.length;
  switch (row.stage as ProposalStage) {
    case "draft":
      return "Drafted, not yet sent to Safe.";
    case "sending":
      return row.submissionAttemptedAt
        ? "Safe submission outcome is being checked. Review your Safe queue; do not send this transaction again."
        : "Drafted, not yet sent to Safe.";
    case "queued":
      if (signed >= threshold) return "Signed. Waiting for execution in Safe.";
      if (signed === 0) return `In your Safe queue. Needs ${sig(threshold)}.`;
      return `${signed} of ${threshold} signed. Needs ${threshold - signed} more ${threshold - signed === 1 ? "signature" : "signatures"}.`;
    case "executed":
      return "Done. Executed in Safe.";
    case "failed":
      return "It did not go through when it ran in Safe. Nothing in your Safe changed.";
    case "not_sent":
      return "Not sent. Safe did not accept it.";
    case "rejected":
      return stoppedLine(-1, queued);
    case "stale":
      return stoppedLine(-3, queued);
    case "stopped":
      return queued ? "Stopped here. It is still in your Safe queue. Reject it in Safe too." : "Stopped. Nothing was sent.";
    case "replaced":
      return "Replaced by a newer plan.";
  }
}

function nextStepOf(needs: number, viewerSigned: boolean): string {
  if (needs === 0) return "All signatures are in. One of you now opens Safe and presses Execute.";
  if (!viewerSigned) return "Your signature is needed. Open Safe, check that the code below matches, then sign.";
  return needs === 1 ? "You signed. Waiting for the other owner." : `You signed. Waiting for ${needs} more owners.`;
}

/** The executed sentence: an open names the dollars now in the Safe; the rest keep the plain sentence (no invented figures). */
function doneLineOf(spec: { kind?: string; borrow?: number; amount?: number; venue?: string; loanId?: string }): string {
  if (spec.kind === "open" && typeof spec.borrow === "number") return `Done. $${fmt(spec.borrow)} USDC is now in your Safe.`;
  if (spec.kind === "repay") {
    const venue = spec.venue ?? LENDER_NAMES[String(spec.loanId ?? "").split(":")[2]] ?? "your lender";
    return `Done. Your repayment transaction ran on your ${venue} loan. Check the loan for its updated balance.`;
  }
  return "Done. Executed in Safe.";
}

function signStateOf(v: ProposalView, row: ProposalRow, f: { threshold: number; viewerOwner: boolean; nonceMatches: boolean | null; blocked: boolean; pending: boolean }): SignState | null {
  switch (v.stage) {
    case "draft": case "sending": return null;
    case "executed": return "executed";
    case "failed": return "failed";
    case "stale": return "out_of_date";
    case "rejected": case "stopped": case "replaced": case "not_sent": return "rejected";
    case "queued": break;
  }
  if (f.pending) return "sending";
  if (f.blocked) return "blocked";
  const signed = v.signedCount;
  if (signed >= f.threshold) return "ready_to_send";
  if (f.viewerOwner && !v.viewerSigned) return "needs_your_signature";
  return "waiting_for_others";
}

export function proposalView(rowIn: ProposalRow, opts: { viewer: Address; threshold: number; safeAddress: Address; chain?: ChainFacts }): ProposalView {
  const { threshold } = opts;
  // Only current owners' approvals count: a removed owner's signature is dropped when the transaction executes.
  const liveOwners = rowIn.stage === "queued" ? opts.chain?.owners ?? null : null;
  const row = liveOwners
    ? { ...rowIn, confirmations: rowIn.confirmations.filter((c) => liveOwners.some((o) => o.toLowerCase() === c.owner.toLowerCase())) }
    : rowIn;
  const stage = row.stage as ProposalStage;
  const signed = row.confirmations.length;
  const hash = row.tx ? safeTxHash(row.chainId as ChainId, opts.safeAddress, row.tx as SafeTx) : null;
  // Still in the Safe queue: it was sent and the agent's delete did not go through.
  const queued = !!row.safeTxHash && !row.deletedFromQueue;
  const stillOpenInSafe = queued && ["rejected", "stale", "stopped", "replaced"].includes(stage);
  const testRun = row.testRun as { line?: string; reason?: string } | null;
  const viewer = opts.viewer.toLowerCase();
  const { segments } = stageOf(row, threshold);
  const view: ProposalView = {
    id: row.id,
    chainId: row.chainId as ChainId,
    title: row.title,
    steps: row.steps,
    outcome: row.outcome,
    stage,
    segments,
    sentence: sentenceOf(row, threshold, stillOpenInSafe),
    needsSignatures: stage === "queued" ? Math.max(0, threshold - signed) : 0,
    signedCount: signed,
    links: { tx: hash ? safeTxLink(row.chainId as ChainId, opts.safeAddress, hash) : null, queue: safeQueueLink(row.chainId as ChainId, opts.safeAddress) },
    inSafe: stage === "queued" || stage === "executed" || stillOpenInSafe,
    noncePassed: opts.chain?.nonce != null && row.nonce != null ? opts.chain.nonce > row.nonce : null,
    safeTxHash: hash,
    hashMismatch: !!hash && !!row.safeTxHash && row.safeTxHash.toLowerCase() !== hash.toLowerCase(),
    nonce: row.nonce === null ? null : row.nonce.toString(),
    viewerSigned: row.confirmations.some((c) => c.owner.toLowerCase() === viewer),
    // A closed one still in the Safe queue can yet be executed: keep polling.
    final: isFinalStage(stage) && !stillOpenInSafe,
    createdAt: row.createdAt.toISOString(),
    calls: row.tx ? callsOf(row.chainId as ChainId, row.tx as SafeTx) : [],
    specKind: String((row.spec as { kind?: string }).kind ?? "unknown"),
    editable: (stage === "draft" || stage === "queued") && (row.spec as { kind?: string }).kind === "open",
  };
  if (row.confirmations.length > 0) view.approvals = row.confirmations.map((c) => ({ address: c.owner as Address, at: c.submittedAt, isYou: c.owner.toLowerCase() === viewer }));
  const hfIdx = (row.spec as { kind?: string; hfIdx?: unknown }).kind === "open" ? (row.spec as { hfIdx?: unknown }).hfIdx : undefined;
  if (hfIdx === 0 || hfIdx === 1 || hfIdx === 2) view.safety = (["Extra safe", "Balanced", "Lean"] as const)[hfIdx];
  if (row.tx) view.target = (row.tx as SafeTx).to;
  if ((stage === "executed" || stage === "failed") && row.executedTxHash) { view.executionTxHash = row.executedTxHash as Hex; view.executedAt = row.updatedAt.toISOString(); }
  if (stage === "queued") view.countLabel = view.needsSignatures === 0 ? "All signed" : `${signed} of ${threshold} signed`;
  if (stage === "executed") view.doneLine = doneLineOf(row.spec as { kind?: string; borrow?: number });
  if (stage === "queued" && !view.hashMismatch) view.nextStep = nextStepOf(view.needsSignatures, view.viewerSigned);
  const spec = row.spec as { kind?: string; loanId?: string; venueId?: string };
  if ((spec.kind === "protect" || spec.kind === "close" || spec.kind === "repay") && spec.loanId) view.loanId = spec.loanId;
  else if (spec.kind === "open" && spec.venueId) view.loanId = `${row.chainId}:${opts.safeAddress.toLowerCase()}:${spec.venueId}`;
  if (stage === "replaced" && row.replacedBy) view.replacedBy = row.replacedBy;
  const deadline = (row.spec as { kind?: string; deadline?: string }).kind === "close" ? (row.spec as { deadline?: string }).deadline : undefined;
  if (deadline && (stage === "draft" || stage === "queued")) view.signBy = deadline;
  const line = testRun?.line ?? testRun?.reason;
  if (line) view.testRunLine = line;
  if (stillOpenInSafe && stage === "replaced") view.stillQueuedNote = `${STILL_QUEUED} Signing the new proposal does not cancel it: both can be signed, and only one will run.`;
  // Who can sign and send (needs the live owners; without them nothing is offered).
  const chain = opts.chain;
  const owners = chain?.owners ?? null;
  if (stage === "queued" && owners) {
    const signedBy = new Set(row.confirmations.map((c) => c.owner.toLowerCase()));
    view.owners = owners.map((a) => ({ address: a, signed: signedBy.has(a.toLowerCase()), isYou: a.toLowerCase() === viewer }));
    view.threshold = threshold;
  }
  const viewerOwner = !!owners?.some((a) => a.toLowerCase() === viewer);
  const txNonce = row.nonce;
  const chainNonce = chain?.nonce ?? null;
  const outdated = stage === "queued" && chainNonce !== null && txNonce !== null && chainNonce > txNonce;
  const blocked = stage === "queued" && chainNonce !== null && txNonce !== null && chainNonce < txNonce;
  const pending = stage === "queued" ? pendingExecOf(row.testRun) : null;
  if (pending) view.pendingTxHash = pending.txHash;
  let state = signStateOf(view, row, { threshold, viewerOwner, nonceMatches: chainNonce === null || txNonce === null ? null : chainNonce === txNonce, blocked, pending: !!pending });
  if (outdated && !pending) state = "settling";
  if (stage === "failed") view.failedReason = "The transaction reverted when it ran. Nothing in your Safe changed.";
  if (blocked && chain?.blockedBy?.length) view.blockedBy = chain.blockedBy;
  const open = stage === "queued" && !view.hashMismatch && !outdated && !pending && viewerOwner;
  view.canSign = open && !view.viewerSigned;
  const ready = signed >= threshold || (signed === threshold - 1 && !view.viewerSigned);
  view.canSend = open && !blocked && ready;
  view.state = state;
  view.facts = factsOf(row.spec as Record<string, unknown>, row.outcome);
  return view;
}
