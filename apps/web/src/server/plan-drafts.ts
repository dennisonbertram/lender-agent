// One live plan draft per Safe (OC-04, BP-12). Saving a quote for a plan message makes that message
// the live one; earlier plan cards read "Earlier plan for {amount}" (`isLivePlan`). The draft's
// `draftKey` is the Send-to-Safe idempotency key: it stays the same for the life of the draft, so a
// second press does not make a second proposal.
import { and, eq, inArray } from "drizzle-orm";
import { isLivePlan, type PlanDraft } from "@/lib/plan-draft";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import type { Db } from "@/server/db/client";
import { activity, planDrafts, proposals, safes } from "@/server/db/schema";
import { idempotencyKeyFor, sentReceiptOf } from "@/server/proposals/send";

export type StoredDraft = PlanDraft & {
  draftKey: string;
  /** The amount asked for, in dollars. */
  cash: number;
  /** Plan messages this Safe's quote endpoint has already seen: only a message seen for the first time takes over as live. */
  seen: string[];
  /** Send found the plan no longer available: the card is no longer live. */
  outOfDate?: boolean;
};

export type DraftState = {
  live: boolean;
  draftKey: string | null;
  /** The proposal, once it is queued or later. Only then does the card show a receipt. */
  sentId?: string;
  /** "Sent to your Safe: …" built from the stored proposal, so it matches what was sent after any reload or stage. */
  receipt?: string;
  /** A proposal that is still "sending" (outcome unknown): the card shows a pending state. */
  sendingId?: string;
  /** A loan proposal for this Safe is being sent, possibly from another draft or network. */
  pendingSend?: boolean;
  /** Safe did not accept the proposal: the form stays and shows the error. */
  notSent?: { id: string; error: string };
};

/** Stages that mean Safe took the proposal: queued, or anything that follows queued. */
const SENT_STAGES = ["queued", "executed", "failed", "rejected", "stale", "stopped", "replaced"];

/**
 * Did the service ever hold this proposal? "proposed:<id>" is written once when it was queued (send.ts)
 * or found at the service when the agent was removed (agent-role.ts). A "stopped" one with no such row
 * was never sent: removal moved it from "sending" and the service did not have it.
 */
async function wasAccepted(db: Db, stage: string, proposalId: string): Promise<boolean> {
  if (stage !== "stopped") return true;
  const [a] = await db.select({ id: activity.id }).from(activity).where(eq(activity.eventKey, `proposed:${proposalId}`)).limit(1);
  return !!a;
}

const SEEN_MAX = 100;

const parse = (v: unknown): StoredDraft | undefined => (v && typeof v === "object" && "draftKey" in v ? (v as StoredDraft) : undefined);

export async function getDraft(db: Db, safeId: number): Promise<StoredDraft | undefined> {
  const [row] = await db.select().from(planDrafts).where(eq(planDrafts.safeId, safeId)).limit(1);
  return parse(row?.draft);
}

async function put(db: Db, safeId: number, draft: StoredDraft) {
  await db.insert(planDrafts).values({ safeId, draft }).onConflictDoUpdate({ target: planDrafts.safeId, set: { draft, updatedAt: new Date() } });
}

/**
 * Record the plan being quoted for `messageId`. A message seen for the first time becomes the live
 * draft with a fresh key; a message already seen keeps (or loses) its place, so reopening an old
 * thread does not make an old card live. A sent draft is frozen.
 */
export async function saveQuoteDraft(db: Db, safeId: number, input: Omit<PlanDraft, "msgId" | "sentId"> & { messageId?: string; cash: number }): Promise<DraftState> {
  const { messageId, ...fields } = input;
  const current = await getDraft(db, safeId);
  if (!messageId) return stateOf(current, undefined);
  if (current?.msgId === messageId) {
    if (!current.sentId) await put(db, safeId, { ...current, ...fields });
    return stateOf(current.sentId ? current : { ...current, ...fields }, messageId);
  }
  const seen = current?.seen ?? [];
  if (seen.includes(messageId)) return stateOf(current, messageId);
  const draft: StoredDraft = { ...fields, msgId: messageId, draftKey: crypto.randomUUID(), seen: [...seen, messageId].slice(-SEEN_MAX) };
  await put(db, safeId, draft);
  return stateOf(draft, messageId);
}

/** Mark the live draft as sent (once its proposal is queued or later). Its key stays. Returns false when `draftKey` is not the live draft's. */
export async function markDraftSent(db: Db, safeId: number, draftKey: string, proposalId: string): Promise<boolean> {
  const current = await getDraft(db, safeId);
  if (!current || current.draftKey !== draftKey) return false;
  const [p] = await db.select({ stage: proposals.stage }).from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.safeId, safeId))).limit(1);
  if (!p || !SENT_STAGES.includes(p.stage) || !(await wasAccepted(db, p.stage, proposalId))) return true; // sending or not sent: not a receipt yet
  if (!current.sentId) await put(db, safeId, { ...current, sentId: proposalId });
  return true;
}

/** Send found the plan unavailable: the draft stops being live. */
export async function markDraftOutOfDate(db: Db, safeId: number, draftKey: string): Promise<void> {
  const current = await getDraft(db, safeId);
  if (current && current.draftKey === draftKey && !current.sentId) await put(db, safeId, { ...current, outOfDate: true });
}

/** The draft's state for one plan card. Only a proposal that is queued or later counts as sent. */
export async function draftState(db: Db, safeId: number, messageId: string | undefined, ownedChainIds: readonly number[] = [...SERVED_CHAIN_IDS, 84532]): Promise<DraftState> {
  const current = await getDraft(db, safeId);
  const servedOwned = [...new Set(ownedChainIds.filter((c) => SERVED_CHAIN_IDS.some((served) => served === c) || c === 84532))];
  let visibleCurrent = current;
  if (current?.sentId) {
    const [saved] = await db.select({ chainId: proposals.chainId }).from(proposals)
      .where(and(eq(proposals.safeId, safeId), eq(proposals.id, current.sentId))).limit(1);
    if (!saved || !servedOwned.includes(saved.chainId)) visibleCurrent = { ...current, sentId: undefined };
  }
  const state = stateOf(visibleCurrent, messageId);
  // A generic pending flag survives a fresh message or reload, but reveals no proposal id, chain or receipt.
  const sending = await db.select({ chainId: proposals.chainId, spec: proposals.spec }).from(proposals).where(and(eq(proposals.safeId, safeId), eq(proposals.stage, "sending")));
  const pendingSend = sending.some((p) => servedOwned.includes(p.chainId) && typeof p.spec === "object" && p.spec !== null && "kind" in p.spec && p.spec.kind === "open");
  const withPending = pendingSend ? { ...state, pendingSend: true } : state;
  if (withPending.live && visibleCurrent && !withPending.sentId) {
    const draft = visibleCurrent;
    // Send to Safe stores sha256(chainId, safe, draftKey) as the idempotency key (send.ts).
    const [safe] = await db.select({ address: safes.address }).from(safes).where(eq(safes.id, safeId)).limit(1);
    const keys = [draft.draftKey, ...(safe ? servedOwned.map((c) => idempotencyKeyFor(c, safe.address, draft.draftKey)) : [])];
    const [p] = await db.select({ id: proposals.id, chainId: proposals.chainId, stage: proposals.stage, stopReason: proposals.stopReason }).from(proposals)
      .where(and(eq(proposals.safeId, safeId), inArray(proposals.idempotencyKey, keys))).limit(1);
    if (p && servedOwned.includes(p.chainId)) {
      if (SENT_STAGES.includes(p.stage) && (await wasAccepted(db, p.stage, p.id))) return withReceipt(db, { ...withPending, sentId: p.id });
      if (p.stage === "sending") return { ...withPending, sendingId: p.id };
      if (p.stage === "not_sent") return { ...withPending, notSent: { id: p.id, error: p.stopReason ?? "The Safe service did not accept it." } };
    }
  }
  return withReceipt(db, withPending);
}

/** Adds the receipt from the stored proposal once the state has a `sentId`. */
async function withReceipt(db: Db, state: DraftState): Promise<DraftState> {
  if (!state.sentId) return state;
  const [row] = await db.select().from(proposals).where(eq(proposals.id, state.sentId)).limit(1);
  const receipt = row ? sentReceiptOf(row) : null;
  return receipt ? { ...state, receipt } : state;
}

function stateOf(d: StoredDraft | undefined, messageId: string | undefined): DraftState {
  const live = !!messageId && !d?.outOfDate && isLivePlan(d, messageId);
  return live && d ? { live, draftKey: d.draftKey, ...(d.sentId ? { sentId: d.sentId } : {}) } : { live: false, draftKey: null };
}
