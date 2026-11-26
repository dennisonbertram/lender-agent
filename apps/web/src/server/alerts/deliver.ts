// Delivery of written alerts (BP-20, BP-21): the chat message and Activity row, then email to each owner
// who gave an address. Every step is idempotent and retried by the next call, so a crash or a provider
// failure delays an alert and never loses or doubles it.
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { alertTitle } from "@/lib/loan-copy";
import { recordActivity } from "@/server/activity";
import { appendServerMessage } from "@/server/agent/persist";
import { alertDeliveries, alerts, emailPrefs, safes, users } from "@/server/db/schema";
import { alertEmail } from "@/server/email/compose";
import { getEmailProvider } from "@/server/email/provider";
import { unsubscribeTokenOf } from "@/server/email/prefs";
import { applyRule } from "@/server/rules/run";
import type { Address, ChainId } from "@/shared/types";
import type { AlertDeps } from "./crossing";
import { venueOfLoanId } from "./venue";

/** After this many failed sends an email is given up on (and an Activity row says so). */
export const MAX_EMAIL_ATTEMPTS = 5;
/** Wait before the next attempt: 2 min, then 4, 8, 16. */
export const emailBackoffMs = (attempts: number) => 120_000 * 2 ** (attempts - 1);

type AlertRow = typeof alerts.$inferSelect;

/** The chat message and Activity row of one alert; ids are fixed, so a retry writes each once. */
async function post(deps: AlertDeps, a: AlertRow): Promise<void> {
  const { db, now } = deps;
  const title = alertTitle(venueOfLoanId(a.loanId), a.hf);
  // BP-25: the standing rule runs before the alert is written, so the alert arrives with its fix drafted (or the reason it was not).
  const rule = await applyRule(deps, a);
  await appendServerMessage(db, a.safeId, {
    id: `alert-${a.id}`,
    parts: [{ type: "data-alert", data: { alertId: a.id, loanId: a.loanId, text: `${a.cause ? `${title}. ${a.cause}` : `${title}.`}${rule ? ` ${rule}` : ""}` } }],
  });
  await recordActivity(db, {
    safeId: a.safeId, chainId: a.chainId as ChainId, actor: "Agent", kind: "status", at: a.createdAt, eventKey: `alert:${a.id}`,
    text: `${title}.${a.cause ? ` ${a.cause}` : ""}`,
    detail: `Health factor ${a.hf.toFixed(2)}, below your At-risk level of ${a.act}.`,
  });
  await db.update(alerts).set({ chatPostedAt: now }).where(eq(alerts.id, a.id));
}

/** One delivery row per owner with an address who has not turned email off. Owners are read from chain (G4). */
async function planEmails(deps: AlertDeps, a: AlertRow, safeAddress: string): Promise<void> {
  const { db, reader, now } = deps;
  const owners = await reader.readSafeOwners(a.chainId as ChainId, safeAddress as Address);
  if (owners === null) throw new Error(`owners of ${safeAddress} on ${a.chainId} not readable`);
  const lower = owners.map((o) => o.toLowerCase());
  const rows = (await db.select({ id: users.id, address: users.address, email: users.email, enabled: emailPrefs.enabled })
    .from(users).leftJoin(emailPrefs, eq(emailPrefs.userId, users.id)))
    .filter((u) => lower.includes(u.address.toLowerCase()) && !!u.email && u.enabled !== false);
  for (const u of rows) {
    await db.insert(alertDeliveries).values({ alertId: a.id, userId: u.id, key: `alert:${a.id}:user:${u.id}`, nextAttemptAt: now }).onConflictDoNothing();
  }
  await db.update(alerts).set({ emailPlannedAt: now }).where(eq(alerts.id, a.id));
}

async function sendDue(deps: AlertDeps, safeId?: number): Promise<void> {
  const { db, now, log } = deps;
  const provider = deps.email === undefined ? getEmailProvider() : deps.email;
  const due = await db.select({ d: alertDeliveries, a: alerts, safeName: safes.name, safeAddress: safes.address })
    .from(alertDeliveries)
    .innerJoin(alerts, eq(alerts.id, alertDeliveries.alertId))
    .innerJoin(safes, eq(safes.id, alerts.safeId))
    .where(and(eq(alertDeliveries.status, "pending"), lte(alertDeliveries.nextAttemptAt, now), ...(safeId === undefined ? [] : [eq(alerts.safeId, safeId)])))
    .orderBy(asc(alertDeliveries.id));
  for (const { d, a, safeName, safeAddress } of due) {
    if (!provider) { log("alerts: email is not configured; not sent"); return; }
    const [u] = await db.select({ email: users.email, enabled: emailPrefs.enabled }).from(users).leftJoin(emailPrefs, eq(emailPrefs.userId, users.id)).where(eq(users.id, d.userId));
    // Turned off (or the address removed) since the alert was written: nothing is sent.
    if (!u?.email || u.enabled === false) {
      await db.update(alertDeliveries).set({ status: "skipped" }).where(eq(alertDeliveries.id, d.id));
      continue;
    }
    const msg = alertEmail({ safeName, safeAddress, chainId: a.chainId, venue: venueOfLoanId(a.loanId), hf: a.hf, alertId: a.id, unsubscribeToken: await unsubscribeTokenOf(db, d.userId) });
    try {
      await provider.send({ to: u.email, subject: msg.subject, text: msg.text, unsubscribeUrl: msg.unsubscribeUrl, idempotencyKey: d.key });
      await db.update(alertDeliveries).set({ status: "sent", attempts: d.attempts + 1, sentAt: now, lastError: null }).where(eq(alertDeliveries.id, d.id));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const attempts = d.attempts + 1;
      const giveUp = attempts >= MAX_EMAIL_ATTEMPTS;
      log(`alerts: email for alert ${a.id} failed (attempt ${attempts}${giveUp ? ", giving up" : ""})`, error);
      await db.update(alertDeliveries).set({ attempts, lastError: error, status: giveUp ? "failed" : "pending", nextAttemptAt: new Date(now.getTime() + emailBackoffMs(attempts)) }).where(eq(alertDeliveries.id, d.id));
      if (giveUp) {
        await recordActivity(db, { safeId: a.safeId, chainId: a.chainId as ChainId, actor: "Agent", kind: "status", at: now, eventKey: `alert-email-failed:${d.id}`,
          text: "Could not email an owner about the loan alert.", detail: error });
      }
    }
  }
}

/** Deliver every written alert that is not delivered yet (of one Safe, or all), and every email that is due. Never throws for one alert's failure. */
export async function deliverAlerts(deps: AlertDeps, safeId?: number): Promise<void> {
  const { db, log } = deps;
  const where = (extra: ReturnType<typeof isNull>) => and(extra, ...(safeId === undefined ? [] : [eq(alerts.safeId, safeId)]));
  const pending = await db.select({ a: alerts, address: safes.address }).from(alerts).innerJoin(safes, eq(safes.id, alerts.safeId))
    .where(where(isNull(alerts.chatPostedAt))).orderBy(asc(alerts.id));
  for (const { a } of pending) {
    try { await post(deps, a); } catch (e) { log(`alerts: chat post of alert ${a.id} failed`, e); }
  }
  const unplanned = await db.select({ a: alerts, address: safes.address }).from(alerts).innerJoin(safes, eq(safes.id, alerts.safeId))
    .where(where(isNull(alerts.emailPlannedAt))).orderBy(asc(alerts.id));
  for (const { a, address } of unplanned) {
    try { await planEmails(deps, a, address); } catch (e) { log(`alerts: email plan for alert ${a.id} failed`, e); }
  }
  try { await sendDue(deps, safeId); } catch (e) { log("alerts: email delivery failed", e); }
}
