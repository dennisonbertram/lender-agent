// BP-20: decide a crossing from the stored snapshots and the saved levels, write one alert per crossing,
// then hand it to delivery. Called by the monitor tick after it stored a loan's snapshot.
//
// A loan is "crossed" from the snapshot that puts health below its At-risk level until one that puts it
// back at the Watch level. One alert is written when it becomes crossed; none while it stays crossed;
// a new one if it recovers to Watch and falls again.
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { alertAmounts } from "@/lib/alerts";
import { DEFAULT_LEVELS, fixTargetHf } from "@/lib/loan-math";
import type { Loan } from "@/lib/types";
import { recordActivity } from "@/server/activity";
import type { ChainReader } from "@/server/chain/reader";
import type { Db } from "@/server/db/client";
import { alertState, alerts, snapshots } from "@/server/db/schema";
import type { EmailProvider } from "@/server/email/provider";
import { levelsByLoan } from "@/server/levels";
import type { Services } from "@/server/services";
import { NETWORK_OF, type ChainId, type LoanPosition } from "@/shared/types";
import { appendServerMessage } from "@/server/agent/persist";
import { alertCause } from "./cause";
import { deliverAlerts } from "./deliver";
import { venueNameOf, venueOfLoanId } from "./venue";

export type AlertDeps = {
  db: Db;
  reader: ChainReader;
  now: Date;
  log: (message: string, detail?: unknown) => void;
  /** Email transport; defaults to the configured one (none configured: no email). */
  email?: EmailProvider | null;
  /** Write only; leave delivery to the next `deliverAlerts` (tests). */
  skipDelivery?: boolean;
  /** Services for the standing rule's fix functions (BP-25); the process services when unset. */
  services?: Services;
};

/** Health must be this far above the Watch level before the next fall into the Watch band posts another message. */
export const WATCH_REARM_MARGIN = 0.05;

const label = (asset: string) => (asset === "WETH" ? "ETH" : asset);

/** The loan as the alert options see it; null when the position has several assets (no single option can be sized). */
export function loanSnap(p: LoanPosition): Loan | null {
  if (p.collateral.length !== 1 || p.debt.length !== 1 || p.collateral[0].amount <= 0) return null;
  const [c] = p.collateral;
  const [d] = p.debt;
  if (d.asset !== "USDC" && d.asset !== "DAI") return null;
  const collAsset = label(c.asset);
  if (collAsset !== "ETH" && collAsset !== "wstETH" && collAsset !== "WBTC") return null;
  return { id: p.id, safeId: p.safe.toLowerCase(), network: NETWORK_OF[p.chainId], venue: venueNameOf(p.lender), collAsset, collAmount: c.amount, debtAsset: d.asset, debt: d.amount, lt: p.liquidationThreshold, apr: 0, accrued: 0 };
}

export async function onSnapshot(deps: AlertDeps, input: { safeId: number; position: LoanPosition; healthFactor?: number; valuationUnavailable?: boolean }): Promise<void> {
  const { db, now, log } = deps;
  const { safeId, position } = input;
  const loanId = position.id.toLowerCase();
  try {
    const history = (await db.select().from(snapshots)
      .where(and(eq(snapshots.safeId, safeId), eq(snapshots.loanId, position.id), gte(snapshots.at, new Date(now.getTime() - 24 * 3_600_000))))
      .orderBy(desc(snapshots.at), desc(snapshots.id))).reverse();
    const latest = history[history.length - 1];
    const hf = input.healthFactor ?? (latest ? Number(latest.health) : Number.NaN);
    if (Number.isFinite(hf) || hf === Infinity) {
      const levels = (await levelsByLoan(db, safeId)).get(loanId) ?? DEFAULT_LEVELS;
      const [state] = await db.select().from(alertState).where(and(eq(alertState.safeId, safeId), eq(alertState.loanId, loanId)));
      const crossed = state?.crossed ?? false;
      // A debt-free loan has no finite health: nothing to cross.
      const belowWatch = state?.belowWatch ?? false;
      const currentSnapshot = input.valuationUnavailable ? null : latest ?? null;
      if (!crossed && Number.isFinite(hf) && hf < levels.act) await writeAlert(deps, safeId, position, currentSnapshot, history, hf, levels);
      else if (crossed && (!Number.isFinite(hf) || hf >= levels.warn)) await resolve(deps, safeId, position, loanId, hf);
      else if (!crossed && !belowWatch && Number.isFinite(hf) && hf < levels.warn) await postWatch(deps, safeId, position, loanId, hf, levels);
      // Re-arm only on no debt (Infinity) or a real recovery; NaN is an unreadable health, not a recovery. 1e-9 absorbs float error (1.6 + 0.05).
      if (belowWatch && (hf === Infinity || hf >= levels.warn + WATCH_REARM_MARGIN - 1e-9)) {
        await db.update(alertState).set({ belowWatch: false, updatedAt: now }).where(and(eq(alertState.safeId, safeId), eq(alertState.loanId, loanId)));
      }
    }
  } catch (e) {
    // A failure here is retried by the next tick; the alert state remains unchanged.
    log(`alerts: ${position.id} failed`, e);
  }
  if (!deps.skipDelivery) await deliverAlerts(deps, safeId);
}

async function writeAlert(deps: AlertDeps, safeId: number, p: LoanPosition, latest: typeof snapshots.$inferSelect | null, history: (typeof snapshots.$inferSelect)[], hf: number, levels: { warn: number; act: number }) {
  const { db, now } = deps;
  const loanId = p.id.toLowerCase();
  const snap = loanSnap(p);
  const price = !latest || latest.price === null ? null : Number(latest.price);
  const sized = snap && price ? alertAmounts(snap, price, fixTargetHf(levels)) : null;
  const asset = snap?.collAsset ?? "Your collateral";
  const cause = latest ? alertCause(asset, history.map((r) => ({ at: r.at, price: r.price === null ? null : Number(r.price), debt: Number(r.debt), rate: r.rate === null ? null : Number(r.rate) })), now) : null;
  await db.transaction(async (tx) => {
    await tx.insert(alerts).values({
      safeId, chainId: p.chainId, loanId, hf, warn: levels.warn, act: levels.act, price, cause, snap,
      addColl: sized?.addColl ?? null, repay: sized?.repay ?? null,
      eventKey: `alert:${loanId}:${now.getTime()}`, createdAt: now,
    });
    await tx.insert(alertState).values({ safeId, loanId, crossed: true, belowWatch: true, updatedAt: now })
      .onConflictDoUpdate({ target: [alertState.safeId, alertState.loanId], set: { crossed: true, belowWatch: true, updatedAt: now } });
  });
}

/**
 * Health fell into the Watch band (below Watch, at or above At-risk): one chat message and one Activity row, no alert, no email.
 * The flag is set last, so a crash between the post and the flag repeats the message on the next tick rather than losing it.
 * ponytail: the key carries the tick time, so that rare crash posts twice; key it on the descent if it ever matters.
 */
async function postWatch(deps: AlertDeps, safeId: number, p: LoanPosition, loanId: string, hf: number, levels: { warn: number; act: number }) {
  const { db, now } = deps;
  const text = `${venueNameOf(p.lender)} loan is below your Watch level (health ${hf.toFixed(2)}). Nothing to do yet. If it falls to your At-risk level of ${levels.act}, I'll alert you and email the owners.`;
  const key = `watch-${loanId}-${now.getTime()}`;
  await appendServerMessage(db, safeId, { id: key, parts: [{ type: "text", text }] });
  await recordActivity(db, {
    safeId, chainId: p.chainId, actor: "Agent", kind: "status", at: now, eventKey: key,
    text: `${venueNameOf(p.lender)} loan is below your Watch level.`,
    detail: `Health factor ${hf.toFixed(2)}.`,
  });
  await db.insert(alertState).values({ safeId, loanId, crossed: false, belowWatch: true, updatedAt: now })
    .onConflictDoUpdate({ target: [alertState.safeId, alertState.loanId], set: { belowWatch: true, updatedAt: now } });
}

/**
 * A loan that is closed (or gone from its lender) can no longer be below its level: resolve its open alerts and
 * clear its crossing state, with one Activity line. Called by the monitor only after the lender was read without error.
 */
export async function resolveClosed(deps: AlertDeps, safeId: number, chainId: ChainId, loanId: string): Promise<void> {
  const { db, now } = deps;
  const id = loanId.toLowerCase();
  const [before] = await db.select().from(alertState).where(and(eq(alertState.safeId, safeId), eq(alertState.loanId, id)));
  await db.transaction(async (tx) => {
    await tx.update(alerts).set({ resolvedAt: now }).where(and(eq(alerts.safeId, safeId), eq(alerts.loanId, id), eq(alerts.chainId, chainId), isNull(alerts.resolvedAt)));
    await tx.update(alertState).set({ crossed: false, belowWatch: false, updatedAt: now }).where(and(eq(alertState.safeId, safeId), eq(alertState.loanId, id)));
  });
  if (!before?.crossed) return; // only below Watch: the flag is cleared, there was no alert to resolve
  await recordActivity(db, {
    safeId, chainId, actor: "Agent", kind: "status", at: now, eventKey: `alert-closed:${id}:${now.getTime()}`,
    text: `${venueOfLoanId(id)} loan is closed. Its alert is resolved.`,
  });
}

async function resolve(deps: AlertDeps, safeId: number, p: LoanPosition, loanId: string, hf: number) {
  const { db, now } = deps;
  await db.transaction(async (tx) => {
    await tx.update(alerts).set({ resolvedAt: now }).where(and(eq(alerts.safeId, safeId), eq(alerts.loanId, loanId), eq(alerts.chainId, p.chainId), isNull(alerts.resolvedAt)));
    await tx.update(alertState).set({ crossed: false, updatedAt: now }).where(and(eq(alertState.safeId, safeId), eq(alertState.loanId, loanId)));
  });
  await recordActivity(db, {
    safeId, chainId: p.chainId, actor: "Agent", kind: "status", at: now, eventKey: `alert-resolved:${loanId}:${now.getTime()}`,
    text: `${venueNameOf(p.lender)} loan is back at your Watch level.`,
    detail: Number.isFinite(hf) ? `Health factor ${hf.toFixed(2)}.` : "No debt.",
  });
}
