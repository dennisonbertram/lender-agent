// What the executor tells people (BP-41): the chat card, the Activity row and one email per owner. Every figure
// is composed here from chain reads (G1). Ids are fixed, so a retry writes each once (G3).
import { and, eq, isNull, lt } from "drizzle-orm";
import { safeLabel } from "@/lib/address";
import { fmt } from "@/lib/format";
import { reserveUsedCopy } from "@/lib/activity-copy";
import { recordActivity } from "@/server/activity";
import { appendServerMessage } from "@/server/agent/persist";
import type { ChainReader } from "@/server/chain/reader";
import type { Db } from "@/server/db/client";
import { alertState, alerts, emailPrefs, reserveRuns, safes, users } from "@/server/db/schema";
import { appUrl } from "@/server/email/compose";
import { unsubscribeTokenOf } from "@/server/email/prefs";
import type { EmailProvider } from "@/server/email/provider";
import { getEmailProvider } from "@/server/email/provider";
import { AAVE_VENUE_NAME } from "@/server/market-inputs";
import type { Address, ChainId, LoanPosition } from "@/shared/types";
import { loanSnap } from "@/server/alerts/crossing";
import { deliverAlerts, emailBackoffMs, MAX_EMAIL_ATTEMPTS } from "@/server/alerts/deliver";
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import { levelsByLoan } from "@/server/levels";

export type ReserveCard = {
  runId: number;
  /** "Repaid 1,200 USDC from your Reserve Safe." */
  what: string;
  why: string;
  hfBefore: number;
  hfAfter: number;
  /** "The Reserve Safe holds 3,800 USDC. Up to 3,800 USDC more today." */
  left: string;
  /** Present when the reserve could not cover everything: the unmetNote sentence. */
  note?: string;
  draftId?: string;
};

type Deps = { db: Db; reader: ChainReader; now: Date; log: (m: string, d?: unknown) => void; email?: EmailProvider | null };

export const reserveEmailText = (p: { safeName: string; safeAddress: string; chainId: number; unsubscribeUrl: string }) => {
  const link = `${appUrl()}/s/${p.safeAddress.toLowerCase()}/chat`;
  return {
    subject: "Your reserve repaid part of your loan",
    text: [
      `${p.safeName}: your ${AAVE_VENUE_NAME} loan was close to liquidation, so your Reserve Safe repaid part of it without your signature.`,
      "",
      `See what happened: ${link}`,
      "",
      "You get this because you gave this address for loan alerts. It is used for nothing else.",
      `Turn these emails off: ${p.unsubscribeUrl}`,
    ].join("\n"),
  };
};

/** Chat card and Activity row for a repay that the receipt confirmed. */
export async function reportDone(deps: Deps, run: typeof reserveRuns.$inferSelect, c?: { card: ReserveCard; usd: number; repay: number; asset: string; hfBefore: number; hfAfter: number; origin: string }): Promise<void> {
  const { db, now } = deps;
  const copy = c
    ? reserveUsedCopy({ usd: c.usd, venue: AAVE_VENUE_NAME, supply: 0, collAsset: "", repay: c.repay, debtAsset: c.asset, hfBefore: c.hfBefore, hfAfter: c.hfAfter })
    : { text: "Your reserve repayment was confirmed on-chain.", detail: "Updated reserve or loan figures were unavailable." };
  await recordActivity(db, {
    safeId: run.safeId, chainId: run.chainId as ChainId, actor: "Agent (reserve)", kind: "reserve", at: now, eventKey: `reserve-run:${run.id}`,
    text: copy.text, detail: copy.detail,
  });
  await appendServerMessage(db, run.safeId, {
    id: `reserve-${run.id}`,
    parts: c ? [{ type: "data-reserve", data: c.card }] as never : [{ type: "text", text: copy.text }],
  });
}

/**
 * One email per owner with an address who has not turned email off. A failed send is retried by `retryEmails` on later
 * ticks with the alerts' backoff, at most once per run per owner (`emailSentTo`), and given up after MAX_EMAIL_ATTEMPTS rounds.
 */
export async function emailOwners(deps: Deps, run: typeof reserveRuns.$inferSelect): Promise<void> {
  const { db, reader, now, log } = deps;
  if (run.emailPlannedAt || run.emailAttempts >= MAX_EMAIL_ATTEMPTS) return;
  if (run.emailNextAt && run.emailNextAt > now) return;
  const provider = deps.email === undefined ? getEmailProvider() : deps.email;
  const [safe] = await db.select().from(safes).where(eq(safes.id, run.safeId));
  if (!safe) return;
  const owners = await reader.readSafeOwners(run.chainId as ChainId, safe.address as Address);
  if (owners === null) { log(`reserve: owners of ${safe.address} not readable; email retried later`); return; }
  const lower = owners.map((o) => o.toLowerCase());
  const rows = (await db.select({ id: users.id, address: users.address, email: users.email, enabled: emailPrefs.enabled }).from(users).leftJoin(emailPrefs, eq(emailPrefs.userId, users.id)))
    .filter((u) => lower.includes(u.address.toLowerCase()) && !!u.email && u.enabled !== false);
  if (rows.length && !provider) { log("reserve: email is not configured; not sent"); }
  const sentTo = [...run.emailSentTo];
  let allSent = true;
  for (const u of rows) {
    if (!provider) break;
    if (sentTo.includes(u.id)) continue;
    const unsub = `${appUrl()}/api/alerts/unsubscribe?token=${await unsubscribeTokenOf(db, u.id)}`;
    const msg = reserveEmailText({ safeName: safeLabel(safe), safeAddress: safe.address, chainId: run.chainId, unsubscribeUrl: unsub });
    try {
      await provider.send({ to: u.email!, subject: msg.subject, text: msg.text, unsubscribeUrl: unsub, idempotencyKey: `reserve-run:${run.id}:user:${u.id}` });
      sentTo.push(u.id);
      await db.update(reserveRuns).set({ emailSentTo: sentTo }).where(eq(reserveRuns.id, run.id));
    } catch (e) { allSent = false; log(`reserve: email for run ${run.id} failed`, e); }
  }
  if (!allSent) {
    const attempts = run.emailAttempts + 1;
    await db.update(reserveRuns).set({ emailAttempts: attempts, emailNextAt: new Date(now.getTime() + emailBackoffMs(attempts)) }).where(eq(reserveRuns.id, run.id));
    if (attempts >= MAX_EMAIL_ATTEMPTS) log(`reserve: gave up emailing run ${run.id} after ${attempts} attempts`);
  } else if (provider || rows.length === 0) await db.update(reserveRuns).set({ emailPlannedAt: now }).where(eq(reserveRuns.id, run.id));
}

/** Later ticks: send what an earlier tick could not (the run is read again, so the backoff and who was emailed are current). */
export async function retryEmails(deps: Deps, safeId: number): Promise<void> {
  const due = await deps.db.select().from(reserveRuns).where(and(eq(reserveRuns.safeId, safeId), eq(reserveRuns.status, "done"), isNull(reserveRuns.emailPlannedAt), lt(reserveRuns.emailAttempts, MAX_EMAIL_ATTEMPTS)));
  for (const run of due) {
    try { await emailOwners(deps, run); } catch (e) { deps.log(`reserve: email retry for run ${run.id} failed`, e); }
  }
}

/** Failure: Activity row, a plain chat line, and the normal alert if the monitor has not raised one for this loan. Nothing says "repaid". */
export async function reportFailure(deps: Deps, run: typeof reserveRuns.$inferSelect, position: LoanPosition | null, error: string): Promise<void> {
  const { db, now } = deps;
  await recordActivity(db, {
    safeId: run.safeId, chainId: run.chainId as ChainId, actor: "Agent (reserve)", kind: "status", at: now, eventKey: `reserve-run:${run.id}`,
    text: `The reserve could not repay your ${AAVE_VENUE_NAME} loan. Nothing moved from the Reserve Safe.`, detail: error,
  });
  await appendServerMessage(db, run.safeId, { id: `reserve-${run.id}`, parts: [{ type: "text", text: `The reserve could not repay your ${AAVE_VENUE_NAME} loan, so nothing moved from the Reserve Safe. Please check your loan and pick a fix.` }] });
  if (position) await ensureOwnerAlert(deps, run.safeId, position); // no loan left to alert about when it was repaid in full
}

/** The normal alert (BP-20) for a loan the reserve failed to protect, once per crossing, delivered the usual way (chat, Activity, email). */
async function ensureOwnerAlert(deps: Deps, safeId: number, position: LoanPosition): Promise<void> {
  const { db, now } = deps;
  const loanId = position.id.toLowerCase();
  const [state] = await db.select().from(alertState).where(and(eq(alertState.safeId, safeId), eq(alertState.loanId, loanId)));
  if (!state?.crossed) {
    const levels = (await levelsByLoan(db, safeId)).get(loanId) ?? DEFAULT_LEVELS;
    await db.transaction(async (tx) => {
      await tx.insert(alerts).values({ safeId, chainId: position.chainId, loanId, hf: position.healthFactor, warn: levels.warn, act: levels.act, price: null, cause: null, snap: loanSnap(position), eventKey: `alert-reserve:${loanId}:${now.getTime()}`, createdAt: now });
      await tx.insert(alertState).values({ safeId, loanId, crossed: true, updatedAt: now }).onConflictDoUpdate({ target: [alertState.safeId, alertState.loanId], set: { crossed: true, updatedAt: now } });
    });
  }
  await deliverAlerts(deps, safeId);
}

export const leftLine = (balance: number, allowanceLeft: number, asset: string): string =>
  `The Reserve Safe holds ${fmt(balance)} ${asset}. Up to ${fmt(Math.min(balance, allowanceLeft))} ${asset} more today.`;
