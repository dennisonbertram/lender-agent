// The monitor tick (BP-18, architecture 3.2 and 4): per Safe and network with the agent added, read the
// loan from the lender, store a snapshot, and record what the check did. One network failing never
// stops the next; the tick still reports failure so the header stops claiming to watch.
import { sumUsd } from "@/server/loans";
import { and, eq, or } from "drizzle-orm";
import { schema, type Db } from "@/server/db/client";
import type { ChainReader } from "@/server/chain/reader";
import { recordActivity } from "@/server/activity";
import { onSnapshot, resolveClosed } from "@/server/alerts/crossing";
import { deliverAlerts } from "@/server/alerts/deliver";
import { tokenBySymbol } from "@/server/chain/config";
import { chainLenderReads, otherRefs, type LenderReads } from "@/server/lenders/reads";
import type { AdapterPosition, LenderId, MarketRef } from "@/server/lenders/types";
import type { Services } from "@/server/services";
import { reconcileReserveRuns, reconcileUnwatchedReserveRuns, reserveOnSnapshot } from "@/server/reserve/executor/run";
import type { EmailProvider } from "@/server/email/provider";
import { AAVE_VENUE_NAME } from "@/server/market-inputs";
import { CHAIN_NAME as CHAIN_LABEL, type Address, type ChainId, type LoanPosition } from "@/shared/types";

/** One config value (D-09): about once a minute per network. */
export const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 60_000;

export const sourceOf = (chainId: number): string => `${AAVE_VENUE_NAME} on ${CHAIN_LABEL[chainId as ChainId] ?? `network ${chainId}`}`;

export type MonitorDeps = {
  db: Db; reader: ChainReader; now: Date; log: (message: string, detail?: unknown) => void;
  /** Email transport for alerts (BP-21); the configured one when unset. */
  email?: EmailProvider | null;
  /** How Compound and Morpho are read (the chain adapters when unset; a fixture in tests). */
  lenders?: LenderReads;
  /** Services for the standing rule (BP-25); the process services when unset. */
  services?: Services;
};

/** What one lender read gave: its position (null when it has none), the borrow rate, or the error. */
type LenderRead = { lender: LenderId; position: LoanPosition | null; rate: number | null; error?: unknown };

const toLoanPosition = (p: AdapterPosition): LoanPosition => ({
  chainId: p.chainId, safe: p.safe, lender: p.lender, id: `${p.chainId}:${p.safe.toLowerCase()}:${p.lender}`,
  collateral: p.collateral, debt: p.debt, healthFactor: p.health ?? Number.POSITIVE_INFINITY,
  liquidationThreshold: p.liquidationThreshold, ltv: p.liquidationThreshold, mixed: p.mixed, blockNumber: p.blockNumber,
});

const isOpen = (p: LoanPosition | null): p is LoanPosition => !!p && (p.collateral.length > 0 || p.debt.length > 0);

/** Aave: the one account position, with USDC's borrow rate (a rate that cannot be read is stored as unknown). */
async function readAave(reader: ChainReader, chainId: ChainId, safe: Address): Promise<LenderRead> {
  try {
    const { position } = await reader.readAavePosition(chainId, safe);
    let rate: number | null = null;
    if (isOpen(position)) {
      try { rate = (await reader.readAaveMarket(chainId, tokenBySymbol(chainId, "USDC")!.address!)).market.variableBorrowApr; } catch { /* unknown */ }
    }
    return { lender: "aave-v3", position, rate };
  } catch (error) { return { lender: "aave-v3", position: null, rate: null, error }; }
}

/** Compound or Morpho: the position among the lender's offered markets (the one that is only the market's own pair first, as the loans list does). */
async function readOther(reads: LenderReads, chainId: ChainId, safe: Address, lender: LenderId, refs: MarketRef[]): Promise<LenderRead> {
  try {
    const ps = await Promise.all(refs.map((r) => reads.position(r, safe)));
    const held = ps.map((p, i) => ({ p, r: refs[i] })).filter((x) => x.p !== null && (x.p.collateral.length > 0 || x.p.debt.length > 0));
    const pick = held.find((x) => !x.p!.mixed) ?? held[0];
    if (!pick) return { lender, position: null, rate: null };
    let rate: number | null = null;
    try { rate = (await reads.market(pick.r)).borrowApr; } catch { /* unknown */ }
    return { lender, position: toLoanPosition(pick.p!), rate };
  } catch (error) { return { lender, position: null, rate: null, error }; }
}

export async function runMonitorTick({ db, reader, now, log, email, services, lenders = services?.lenders ?? chainLenderReads }: MonitorDeps): Promise<void> {
  const deps = { db, reader, now, log, email, skipDelivery: true, services };
  await reconcileUnwatchedReserveRuns(deps);
  const rows = await db
    .select({ safeId: schema.safes.id, address: schema.safes.address, chainId: schema.safeNetworks.chainId })
    .from(schema.safeNetworks)
    .innerJoin(schema.safes, eq(schema.safes.id, schema.safeNetworks.safeId))
    .where(eq(schema.safeNetworks.agentAdded, true));
  const failures: string[] = [];
  for (const r of rows) {
    const chainId = r.chainId as ChainId;
    const safe = r.address as Address;
    const [before] = await db.select().from(schema.monitorStatus)
      .where(and(eq(schema.monitorStatus.safeId, r.safeId), eq(schema.monitorStatus.chainId, r.chainId)));
    let error: string | null = null;
    let loanCount = 0;
    try {
      // Every allowed lender on the network (the allowlist), read on its own: one failing never hides the others.
      const byLender = new Map<LenderId, MarketRef[]>();
      for (const ref of otherRefs(chainId)) byLender.set(ref.lender, [...(byLender.get(ref.lender) ?? []), ref]);
      const reads = await Promise.all([
        readAave(reader, chainId, safe),
        ...[...byLender].map(([lender, refs]) => readOther(lenders, chainId, safe, lender, refs)),
      ]);
      const errors: string[] = [];
      const present = new Set<string>();
      for (const read of reads) {
        if (read.error !== undefined) {
          const msg = read.error instanceof Error ? read.error.message : String(read.error);
          errors.push(read.lender === "aave-v3" ? msg : `${read.lender}: ${msg}`);
          log(`monitor: ${r.chainId}:${r.address} ${read.lender} failed`, read.error);
          continue;
        }
        const position = read.position;
        if (!isOpen(position)) continue;
        present.add(position.id.toLowerCase());
        try {
          await snapshotLoan(deps, r.safeId, position, read.rate);
          loanCount++;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
          log(`monitor: ${r.chainId}:${r.address} ${position.id} failed`, e);
        }
      }
      await reconcileReserveRuns(deps, r.safeId, chainId); // pending Reserve runs, even when the repay cleared the loan
      // A loan that was crossed or below Watch and is gone from a lender we read without error is closed: resolve it.
      const readOk = new Set(reads.filter((x) => x.error === undefined).map((x) => x.lender));
      const crossed = await db.select().from(schema.alertState).where(and(eq(schema.alertState.safeId, r.safeId), or(eq(schema.alertState.crossed, true), eq(schema.alertState.belowWatch, true))));
      for (const c of crossed) {
        const [cid, , lender] = c.loanId.split(":");
        if (Number(cid) !== chainId || present.has(c.loanId) || !readOk.has(lender as LenderId)) continue;
        try { await resolveClosed(deps, r.safeId, chainId, c.loanId); } catch (e) { log(`alerts: closing ${c.loanId} failed`, e); }
      }
      if (errors.length) error = errors.join("; ");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log(`monitor: ${r.chainId}:${r.address} failed`, e);
    }
    // Delivery does not depend on a position being read: an alert committed earlier is posted and emailed now (BP-20/21).
    try { await deliverAlerts(deps, r.safeId); } catch (e) { log(`alerts: delivery for safe ${r.safeId} failed`, e); }
    if (error !== null) failures.push(`${r.chainId}:${r.address}: ${error}`);
    const next = {
      lastCheckAt: now,
      lastOkAt: error === null ? now : before?.lastOkAt ?? null,
      lastError: error,
      source: sourceOf(r.chainId),
      loanCount: error === null ? loanCount : before?.loanCount ?? 0,
    };
    await db.insert(schema.monitorStatus).values({ safeId: r.safeId, chainId: r.chainId, ...next })
      .onConflictDoUpdate({ target: [schema.monitorStatus.safeId, schema.monitorStatus.chainId], set: next });
    // G3: log only the change of state, so a minute-by-minute tick does not flood Activity.
    const wasFailing = !!before?.lastError;
    if (error !== null && !wasFailing) {
      await recordActivity(db, { safeId: r.safeId, chainId, actor: "Agent", kind: "status", at: now, eventKey: `monitor-fail:${r.safeId}:${r.chainId}:${now.getTime()}`,
        text: `Could not read your loans on ${CHAIN_LABEL[chainId] ?? r.chainId}. Not watching them until it can.`, detail: error });
    } else if (error === null && wasFailing) {
      await recordActivity(db, { safeId: r.safeId, chainId, actor: "Agent", kind: "status", at: now, eventKey: `monitor-ok:${r.safeId}:${r.chainId}:${now.getTime()}`,
        text: `Watching your loans on ${CHAIN_LABEL[chainId] ?? r.chainId} again.` });
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}

/** Store one loan's snapshot with that lender's health, then check the crossing (BP-20). */
async function snapshotLoan(deps: Parameters<typeof onSnapshot>[0], safeId: number, position: LoanPosition, rate: number | null): Promise<void> {
  const collateralUsd = sumUsd(position.collateral);
  const debtUsd = sumUsd(position.debt);
  // Health from the lender is independent of USD valuation: evaluate crossings, but do not invent
  // snapshot amounts, size fixes, or run the Reserve's automatic-spending path without prices.
  if (collateralUsd === null || debtUsd === null) {
    await onSnapshot(deps, { safeId, position, healthFactor: position.healthFactor, valuationUnavailable: true });
    deps.log(`monitor: ${position.id} health checked; USD snapshot and automatic fixes skipped because a price is unavailable`);
    return;
  }
  const single = position.collateral.length === 1 && position.collateral[0].amount > 0 ? position.collateral[0] : null;
  await deps.db.insert(schema.snapshots).values({
    safeId,
    chainId: position.chainId,
    loanId: position.id,
    at: deps.now,
    blockNumber: position.blockNumber,
    health: String(position.healthFactor),
    price: single && single.usd !== null ? String(single.usd / single.amount) : null,
    debt: String(debtUsd),
    collateral: String(collateralUsd),
    rate: rate === null ? null : String(rate),
  });
  await onSnapshot(deps, { safeId, position }); // BP-20/21
  await reserveOnSnapshot(deps, { safeId, position }); // BP-41
}
