// Choose a fix and get a draft (BP-22) and send it (BP-23). The draft is the typed protect `Spec` built by the
// same Test run as every proposal; sending stores the exact transaction first and then delivers it with
// `deliver` from the proposal sender (no second sender). An urgent fix is proposed at the Safe's current
// nonce as a competing transaction (D-10).
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getAddress } from "viem";
import { fmt } from "@/lib/format";
import { healthFactor } from "@/lib/loan-math";
import { requiredSignatures } from "@/lib/loan-copy";
import { compute, type Spec } from "@/lib/proposals";
import { requireNetwork } from "@/server/auth/access";
import { assertAgentActive } from "@/server/agent-role";
import { fixDrafts, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/client";
import { HttpError } from "@/server/http";
import { AAVE_VENUE_ID, M1_NETWORKS } from "@/server/market-inputs";
import { deliver, idempotencyKeyFor, resultOf, SendBlocked, withNextProposalNonce, type SendResult } from "@/server/proposals/send";
import { testRun } from "@/server/proposals/test-run";
import { proposalView } from "@/server/proposals/view";
import type { SafeContext } from "@/server/request";
import { safeTxHash } from "@/server/safe/hash";
import { isChainId, type Address, type ChainId, type SafeTx } from "@/shared/types";
import { stillNeedsSignature, urgentNote } from "./copy";
import { chainIdOfLoan, fixOptionsFor, liveLoan, type LiveLoan } from "./options";

export type FixOptionKey = "coll" | "repay" | "both";

export type FixDraftView = {
  id: string;
  loanId: string;
  chainId: ChainId;
  option: FixOptionKey;
  title: string;
  steps: string[];
  healthBefore: number | null;
  healthAfter: number | null;
  testRunLine: string;
  canSend: boolean;
  urgent: boolean;
  /** Present on an urgent fix: signing does not cancel the other transaction at this nonce (D-10). */
  urgentNote: string | null;
  /** "It still needs N signatures." (r30: a pick is not consent to send.) */
  stillNeeds: string;
  state: "draft" | "replaced" | "sent";
  proposalId: string | null;
  spec: Spec;
};

type Row = typeof fixDrafts.$inferSelect;

const finite = (n: number | null) => (n !== null && Number.isFinite(n) ? n : null);

async function viewOf(ctx: Pick<SafeContext, "services">, row: Row, chainId: ChainId, safe: Address): Promise<FixDraftView> {
  const needs = requiredSignatures(String((await ctx.services.reader.readSafeThreshold(chainId, safe)) ?? 2));
  return {
    id: row.id, loanId: row.loanId, chainId, option: row.option as FixOptionKey, title: row.title, steps: row.steps,
    healthBefore: finite(row.healthBefore), healthAfter: finite(row.healthAfter), testRunLine: row.testRunLine, canSend: row.canSend,
    urgent: row.urgent, urgentNote: row.urgent ? urgentNote() : null, stillNeeds: stillNeedsSignature(needs),
    state: row.state as FixDraftView["state"], proposalId: row.proposalId, spec: row.spec as Spec,
  };
}

/** Compound and Morpho: the simulation reads only Aave's account, so health after is the plan's own figure (as for their opens). */
const predictedFor = (f: LiveLoan, spec: Extract<Spec, { kind: "protect" }>): { predictedHealthAfter?: number } =>
  f.lender === AAVE_VENUE_ID ? {} : { predictedHealthAfter: healthFactor((f.loan.collAmount + spec.addColl) * f.prices[f.loan.collAsset], f.loan.lt, f.loan.debt - spec.repay) };

/** Draft the picked option. Amounts are recomputed from live data now; any earlier live draft for the loan becomes "Replaced". With `onlyIfSendable` a Test run that does not pass is a 409 and the earlier draft stays (the standing rule must never replace a draft with one that cannot be sent). */
export async function draftFix(ctx: SafeContext, input: { loanId: string; option: FixOptionKey }, flags: { onlyIfSendable?: boolean } = {}): Promise<FixDraftView> {
  const { db, services, safe } = ctx;
  const chainId = chainIdOfLoan(input.loanId);
  if (!isChainId(chainId) || !input.loanId.toLowerCase().includes(`:${safe.address.toLowerCase()}:`)) throw new HttpError(404, "Loan not found");
  requireNetwork(ctx.access, chainId);
  const safeAddress = getAddress(safe.address) as Address;
  await assertAgentActive(services, chainId, safeAddress);

  const found = await liveLoan({ db, services }, safe, input.loanId);
  const opts = await fixOptionsFor(safe, { id: input.loanId, chainId }, { db, services });
  const picked = opts?.options.find((o) => o.k === input.option);
  if (!found || !opts || !picked) throw new HttpError(404, "Loan not found");
  if (picked.short) throw new HttpError(409, picked.sub);

  const spec = { kind: "protect" as const, loanId: found.loan.id, addColl: picked.addColl, repay: picked.repay };
  const tr = await testRun({
    chainId, safe: safeAddress, spec, healthBefore: found.hf, atRiskLevel: opts.levels.act, loan: { collAsset: found.loan.collAsset, debtAsset: "USDC" }, ...predictedFor(found, spec),
  }, services.testRunDeps);
  if (flags.onlyIfSendable && !tr.canSend) throw new HttpError(409, `the test run did not pass (${tr.line})`);
  const shown = compute(spec, found.loans, { prices: found.prices, venues: found.inputs.venues, networks: M1_NETWORKS, feeEstimateUsd: tr.feeUsd });

  const row: Row = {
    id: randomUUID(), safeId: safe.id, chainId, loanId: found.loan.id, option: input.option, spec, title: shown.title, steps: tr.steps,
    healthBefore: found.hf, healthAfter: finite(tr.healthAfter), testRunLine: tr.line, canSend: tr.canSend, urgent: opts.urgent,
    state: "draft", proposalId: null, createdAt: new Date(),
  };
  await db.update(fixDrafts).set({ state: "replaced" })
    .where(and(eq(fixDrafts.safeId, safe.id), eq(fixDrafts.loanId, found.loan.id), eq(fixDrafts.state, "draft")));
  await db.insert(fixDrafts).values(row);
  return viewOf(ctx, row, chainId, safeAddress);
}

export type FixSendResult = SendResult & { /** The receipt line once the service has it. */ receipt: string | null };

const receiptOf = (title: string, steps: string[], stage: string): string | null =>
  stage === "queued" ? `Sent to your Safe: ${title.toLowerCase()}. ${steps.filter((s) => !s.startsWith("Allow ")).join("; ")}.` : null;

const outcomeOf = (spec: Spec, collAsset: string): string => {
  const p = spec as Extract<Spec, { kind: "protect" }>;
  const uses = [p.addColl > 0 && `${fmt(p.addColl, 2)} ${collAsset}`, p.repay > 0 && `${fmt(p.repay)} USDC`].filter(Boolean).join(" and ");
  return `Uses ${uses} from the Safe.`;
};

/** Send a draft to the Safe through the proposal sender. A replaced draft is refused; a second press returns the same proposal. */
export async function sendFix(ctx: SafeContext, draftId: string): Promise<FixSendResult> {
  const { db, services, safe, wallet } = ctx;
  const [d] = await db.select().from(fixDrafts).where(and(eq(fixDrafts.id, draftId), eq(fixDrafts.safeId, safe.id))).limit(1);
  if (!d) throw new HttpError(404, "Fix not found");
  const chainId = d.chainId as ChainId;
  requireNetwork(ctx.access, chainId);
  const safeAddress = getAddress(safe.address) as Address;
  await assertAgentActive(services, chainId, safeAddress);

  const key = idempotencyKeyFor(chainId, safe.address, `fix:${d.id}`);
  const [existing] = await db.select().from(proposals).where(eq(proposals.idempotencyKey, key)).limit(1);
  if (existing) {
    const row = existing.stage === "sending" ? await deliver(db, services, existing, safeAddress) : existing;
    return { ...resultOf(row), receipt: receiptOf(row.title, row.steps, row.stage) };
  }
  if (d.state === "replaced") {
    const reason = "Replaced by a newer fix. Use the newest one.";
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }

  const found = await liveLoan({ db, services }, safe, d.loanId);
  if (!found) throw new SendBlocked("This loan changed. Get new options.", "This loan changed. Get new options. Nothing was sent.");
  const opts = await fixOptionsFor(safe, { id: d.loanId, chainId }, { db, services });
  const levels = opts?.levels;
  const urgent = found.hf < (levels?.act ?? 0);
  const spec = d.spec as Extract<Spec, { kind: "protect" }>;
  // The amounts were sized for the prices at draft time. Health only has to improve to pass the Test run, so after a
  // further fall an old amount could still pass while missing the target: size again from live data, and if it differs,
  // replace the draft and let the user review the new one (a send is consent to the card they saw).
  const fresh = opts?.options.find((o) => o.k === d.option);
  if (fresh && (fresh.addColl !== spec.addColl || fresh.repay !== spec.repay)) {
    const reason = "Prices moved since this was drafted. I drafted new amounts to reach the target. Review them before sending.";
    await draftFix(ctx, { loanId: d.loanId, option: d.option as FixOptionKey }).catch((e) => {
      if (e instanceof HttpError && e.status === 409) throw new SendBlocked(e.message, `${e.message} Nothing was sent.`);
      throw e;
    });
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }
  const tr = await testRun({
    chainId, safe: safeAddress, spec, healthBefore: found.hf, atRiskLevel: levels?.act ?? 0, loan: { collAsset: found.loan.collAsset, debtAsset: "USDC" }, ...predictedFor(found, spec),
  }, services.testRunDeps);
  if (!tr.canSend) throw new SendBlocked(tr.reason ?? "The test run did not pass.", tr.line);

  const onChain = (await services.reader.readSafeNonce(chainId, safeAddress)) ?? 0n;
  const threshold = await services.reader.readSafeThreshold(chainId, safeAddress);
  const store = async (storage: Pick<Db, "insert">, nonce: bigint) => {
    const tx: SafeTx = { ...tr.tx, nonce: nonce.toString() };
    return storage.insert(proposals).values({
      id: randomUUID(), safeId: safe.id, chainId, spec, tx, nonce, safeTxHash: safeTxHash(chainId, safeAddress, tx), idempotencyKey: key,
      title: d.title, steps: tr.steps, outcome: outcomeOf(spec, found.loan.collAsset),
      stage: "sending", threshold,
      testRun: { ok: tr.ok, line: tr.line, feeUsd: tr.feeUsd, healthAfter: finite(tr.healthAfter), reason: tr.reason ?? null },
      createdBy: wallet.toLowerCase(),
    }).onConflictDoNothing({ target: proposals.idempotencyKey }).returning();
  };
  const inserted = urgent ? await store(db, onChain) : await withNextProposalNonce(db, safe.id, chainId, onChain, store);
  if (inserted.length === 0) {
    const [winner] = await db.select().from(proposals).where(eq(proposals.idempotencyKey, key)).limit(1);
    return { ...resultOf(winner), receipt: receiptOf(winner.title, winner.steps, winner.stage) };
  }
  await db.update(fixDrafts).set({ state: "sent", proposalId: inserted[0].id }).where(eq(fixDrafts.id, d.id));
  const row = await deliver(db, services, inserted[0], safeAddress);
  return { ...resultOf(row), receipt: receiptOf(row.title, row.steps, row.stage) };
}

export type FixState = {
  /** What the loan's risk banner says (`riskBanner`): nothing drafted, a draft in chat, or a fix waiting for signatures. */
  fix: "none" | "draft" | "queued";
  draftId?: string;
  proposalId?: string;
  /** Older drafts that a newer one replaced: their cards read "Replaced". */
  replaced: { id: string }[];
};

/** The fix state of one loan from stored rows only (no chain read). */
export async function fixStateFor(db: Db, safeId: number, loanId: string): Promise<FixState> {
  const rows = await db.select().from(fixDrafts).where(and(eq(fixDrafts.safeId, safeId), eq(fixDrafts.loanId, loanId))).orderBy(desc(fixDrafts.createdAt));
  const replaced = rows.filter((r) => r.state === "replaced").map((r) => ({ id: r.id }));
  const sentIds = rows.filter((r) => r.state === "sent" && r.proposalId).map((r) => r.proposalId!);
  const sent = sentIds.length ? await db.select().from(proposals).where(inArray(proposals.id, sentIds)) : [];
  const queued = sent.find((p) => p.stage === "queued");
  if (queued) return { fix: "queued", proposalId: queued.id, replaced };
  const open = rows.find((r) => r.state === "draft") ?? rows.find((r) => r.state === "sent" && sent.some((p) => p.id === r.proposalId && p.stage === "sending"));
  if (open) return { fix: "draft", draftId: open.id, ...(open.proposalId ? { proposalId: open.proposalId } : {}), replaced };
  return { fix: "none", replaced };
}

const stateRank = (s: string) => (s === "draft" ? 0 : 1);

/** Everything one loan's fix card needs: live options, the live draft, older drafts that read "Replaced", and the loan's fix state. */
export async function fixPanel(ctx: SafeContext, loanId: string) {
  const chainId = chainIdOfLoan(loanId);
  if (!isChainId(chainId) || !loanId.toLowerCase().includes(`:${ctx.safe.address.toLowerCase()}:`)) throw new HttpError(404, "Loan not found");
  requireNetwork(ctx.access, chainId);
  const safeAddress = getAddress(ctx.safe.address) as Address;
  const options = await fixOptionsFor(ctx.safe, { id: loanId, chainId }, ctx);
  const state = await fixStateFor(ctx.db, ctx.safe.id, loanId);
  const rows = await ctx.db.select().from(fixDrafts).where(and(eq(fixDrafts.safeId, ctx.safe.id), eq(fixDrafts.loanId, loanId))).orderBy(desc(fixDrafts.createdAt));
  // Only a live draft blocks new options: not sent, or sent and still in the queue / being signed. Executed, rejected, stale or failed ones do not.
  const sentIds = rows.filter((r) => r.state === "sent" && r.proposalId).map((r) => r.proposalId!);
  const sentRows = sentIds.length ? await ctx.db.select({ id: proposals.id, stage: proposals.stage }).from(proposals).where(inArray(proposals.id, sentIds)) : [];
  const liveSent = new Set(sentRows.filter((p) => p.stage === "queued" || p.stage === "sending").map((p) => p.id));
  const live = rows.sort((a, b) => stateRank(a.state) - stateRank(b.state)).find((r) => r.state === "draft" || (r.state === "sent" && !!r.proposalId && liveSent.has(r.proposalId)));
  const draft = live ? await viewOf(ctx, live, chainId, safeAddress) : null;
  let safeLink: string | null = null;
  if (state.proposalId) {
    const [p] = await ctx.db.select().from(proposals).where(eq(proposals.id, state.proposalId)).limit(1);
    if (p) { const v = proposalView(p, { viewer: ctx.wallet, threshold: p.threshold ?? 2, safeAddress }); safeLink = v.links.tx ?? v.links.queue; }
  }
  return { options, state, draft, safeLink };
}

export type WaitingFix = { proposalId: string; loanId: string; title: string; sentence: string; link: string };

/** Fixes that are in the Safe queue now, for the overview's waiting lines (r17): "{title}: {sentence} Open loan · Open in Safe". Only networks where the caller is an owner (G4). */
export async function waitingFixes(ctx: SafeContext): Promise<WaitingFix[]> {
  const rows = await ctx.db.select({ d: fixDrafts, p: proposals }).from(fixDrafts)
    .innerJoin(proposals, eq(proposals.id, fixDrafts.proposalId))
    .where(and(eq(fixDrafts.safeId, ctx.safe.id), eq(fixDrafts.state, "sent"), eq(proposals.stage, "queued"), inArray(fixDrafts.chainId, ctx.access.ownedChainIds)));
  const safeAddress = getAddress(ctx.safe.address) as Address;
  return rows.map(({ d, p }) => {
    const v = proposalView(p, { viewer: ctx.wallet, threshold: p.threshold ?? 2, safeAddress });
    return { proposalId: p.id, loanId: d.loanId, title: p.title, sentence: v.sentence, link: v.links.tx ?? v.links.queue };
  });
}
