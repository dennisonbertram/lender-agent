// Tells the other owners a plan is waiting for their approval (flow-08): one email per proposal per owner who has an
// address and alerts on. Never throws: a failure is logged and the send it follows is untouched.
// Once only: the provider's idempotency key covers a retry, and an Activity row with a fixed eventKey covers a restart.
import { and, eq } from "drizzle-orm";
import { safeLabel, shortAddress } from "@/lib/address";
import { recordActivity } from "@/server/activity";
import type { ChainReader } from "@/server/chain/reader";
import type { Db } from "@/server/db/client";
import { activity, emailPrefs, proposals, safes, users } from "@/server/db/schema";
import { appUrl, cosignerEmail } from "@/server/email/compose";
import { unsubscribeTokenOf } from "@/server/email/prefs";
import { getEmailProvider, type EmailProvider } from "@/server/email/provider";
import { getServices, type Services } from "@/server/services";
import type { Address, ChainId, Hex } from "@/shared/types";

type Deps = { db: Db; reader: ChainReader; log?: (m: string, d?: unknown) => void; email?: EmailProvider | null; safeService?: Services["safeService"] };

const eventKeyOf = (proposalId: string, address: string) => `cosigner:${proposalId}:${address.toLowerCase()}`;

/** Email the owners who still need to approve this proposal. Does nothing unless it is queued and short of signatures. */
export async function notifyCosigners(deps: Deps, proposalId: string): Promise<void> {
  const { db, reader } = deps;
  const log = deps.log ?? ((m: string, d?: unknown) => console.error(`[cosigners] ${m}`, d ?? ""));
  try {
    const provider = deps.email === undefined ? getEmailProvider() : deps.email;
    if (!provider) return;
    const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
    if (!p || p.stage !== "queued" || p.deletedFromQueue) return;
    const [safe] = await db.select().from(safes).where(eq(safes.id, p.safeId));
    if (!safe) return;
    const chainId = p.chainId as ChainId;
    const [owners, readThreshold] = await Promise.all([reader.readSafeOwners(chainId, safe.address as Address), p.threshold === null ? reader.readSafeThreshold(chainId, safe.address as Address) : Promise.resolve(p.threshold)]);
    const threshold = p.threshold ?? readThreshold;
    if (!owners || !threshold) return;
    // Stored confirmations can lag the Safe service: ask it first, and fall back to what is stored.
    let confirmed = p.confirmations.map((c) => c.owner);
    if (p.safeTxHash) {
      try {
        const stx = await (deps.safeService ?? getServices().safeService)(chainId).getMultisigTransaction(p.safeTxHash as Hex);
        if (stx) confirmed = stx.confirmations.map((c) => c.owner);
      } catch (e) { log(`could not refresh confirmations for ${proposalId}; using stored ones`, e); }
    }
    const signed = new Set(confirmed.map((o) => o.toLowerCase()));
    if (signed.size >= threshold) return;
    const skip = new Set([...signed, ...(p.createdBy ? [p.createdBy.toLowerCase()] : [])]);
    const want = new Set(owners.map((o) => o.toLowerCase()).filter((o) => !skip.has(o)));
    if (!want.size) return;
    const rows = (await db.select({ id: users.id, address: users.address, email: users.email, enabled: emailPrefs.enabled }).from(users).leftJoin(emailPrefs, eq(emailPrefs.userId, users.id)))
      .filter((u) => want.has(u.address.toLowerCase()) && !!u.email && u.enabled !== false);
    const spec = p.spec as { kind?: string; deadline?: string };
    for (const u of rows) {
      try {
        const key = eventKeyOf(p.id, u.address);
        const [done] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.safeId, p.safeId), eq(activity.eventKey, key)));
        if (done) continue;
        const unsub = `${appUrl()}/api/alerts/unsubscribe?token=${await unsubscribeTokenOf(db, u.id)}`;
        const msg = cosignerEmail({
          sender: p.createdBy ?? safe.address, title: p.title, safeName: safeLabel(safe), safeAddress: safe.address, chainId,
          threshold, owners: owners.length, signed: signed.size, signBy: spec.kind === "close" ? spec.deadline : undefined, proposalId: p.id, unsubscribeUrl: unsub,
        });
        await provider.send({ to: u.email!, subject: msg.subject, text: msg.text, unsubscribeUrl: unsub, idempotencyKey: key });
        await recordActivity(db, { safeId: p.safeId, chainId, actor: "Agent", kind: "status", proposalId: p.id, eventKey: key, text: `Emailed ${shortAddress(u.address)} that this plan is waiting for their approval.` });
      } catch (e) { log(`email to a co-owner for ${proposalId} failed`, e); }
    }
  } catch (e) {
    (deps.log ?? console.error)(`co-signer notice for ${proposalId} failed`, e);
  }
}

/** Worker pass: proposals that became queued after the route returned. */
export async function notifyQueuedProposals(deps: Deps): Promise<void> {
  const open = await deps.db.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.stage, "queued"), eq(proposals.deletedFromQueue, false)));
  for (const { id } of open) await notifyCosigners(deps, id);
}
