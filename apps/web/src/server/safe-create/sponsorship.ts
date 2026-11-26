// The sponsorship budget in use: counts from the relayer ledger, constants from `lib/safe-create.ts`.
import { and, count, eq, gte, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { relayerDeployments } from "@/server/db/schema";
import { DEFAULT_BUDGET, decideSponsorship, type SponsorshipBudget, type SponsorshipDecision } from "@/lib/safe-create";

/** `SPONSOR_PER_SAFE`, `SPONSOR_DAILY` override the constants; 0 turns sponsorship off. */
export function budgetFromEnv(env: Record<string, string | undefined> = process.env): SponsorshipBudget {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const wei = (v: string | undefined, d: bigint) => { try { return v ? BigInt(v) : d; } catch { return d; } };
  return {
    ...DEFAULT_BUDGET,
    perSafe: num(env.SPONSOR_PER_SAFE, DEFAULT_BUDGET.perSafe),
    perCreator: num(env.SPONSOR_PER_CREATOR, DEFAULT_BUDGET.perCreator),
    daily: num(env.SPONSOR_DAILY, DEFAULT_BUDGET.daily),
    maxCostWei: wei(env.SPONSOR_MAX_COST_WEI, DEFAULT_BUDGET.maxCostWei),
    dailySpendWei: wei(env.SPONSOR_DAILY_SPEND_WEI, DEFAULT_BUDGET.dailySpendWei),
  };
}

export const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const LEASE_MS = 120_000;

export type Reservation =
  | { reserved: true }
  /** Another call holds a live claim for this (Safe, network). */
  | { reserved: false; reason: "claimed" }
  | { reserved: false; reason: Exclude<SponsorshipDecision, { sponsored: true }>["reason"] };

/**
 * Check the budget and take the claim in ONE transaction, serialised by a Postgres advisory lock, so concurrent
 * requests for different Safes cannot all pass the check before any of them is counted. The claim row stores the
 * estimate; `recordCost` replaces it with the actual cost. An expired claim that never reached the chain is re-reserved like a new one: fresh estimate, ceiling and today's budget.
 */
export async function reserveSponsorship(db: Db, p: { safeId: number; creator: string; chainId: number; budget: SponsorshipBudget; estimateWei: bigint; now: Date }): Promise<Reservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`);
    const [mine] = await tx.select().from(relayerDeployments).where(and(eq(relayerDeployments.safeId, p.safeId), eq(relayerDeployments.chainId, p.chainId))).limit(1);
    const lease = new Date(p.now.getTime() + LEASE_MS);
    // A live claim belongs to a call still running. A claim that already has a hash or cost reached the chain: keep it as the ledger.
    if (mine && mine.leaseExpiresAt > p.now) return { reserved: false, reason: "claimed" };
    if (mine && (mine.txHash || mine.costWei !== null)) {
      await tx.update(relayerDeployments).set({ leaseExpiresAt: lease }).where(eq(relayerDeployments.id, mine.id));
      return { reserved: true };
    }
    // A new claim, or an expired one that never reached the chain: both are checked against the current estimate, the ceiling and
    // today's budget (the old row is left out of the counts, as it is replaced below).
    const others = (where: SQL | undefined) => and(where, mine ? ne(relayerDeployments.id, mine.id) : undefined);
    const count1 = (where: SQL | undefined) => tx.select({ n: count() }).from(relayerDeployments).where(others(where)).then((r) => r[0]?.n ?? 0);
    const day = gte(relayerDeployments.createdAt, startOfUtcDay(p.now));
    const [spent] = await tx.select({ v: sql<string>`coalesce(sum(coalesce(${relayerDeployments.costWei}, ${relayerDeployments.estimatedWei})), 0)` }).from(relayerDeployments).where(others(day));
    const decision = decideSponsorship({
      chainId: p.chainId, budget: p.budget, estimateWei: p.estimateWei, dailySpentWei: BigInt(spent?.v ?? 0),
      perSafeUsed: await count1(eq(relayerDeployments.safeId, p.safeId)),
      perCreatorUsed: await count1(eq(relayerDeployments.creator, p.creator.toLowerCase())),
      dailyUsed: await count1(day),
    });
    if (!decision.sponsored) {
      // Refused: the user pays, so the stale claim must not keep holding budget.
      if (mine) await tx.delete(relayerDeployments).where(eq(relayerDeployments.id, mine.id));
      return { reserved: false, reason: decision.reason };
    }
    if (mine) {
      await tx.update(relayerDeployments).set({ estimatedWei: p.estimateWei.toString(), createdAt: p.now, leaseExpiresAt: lease }).where(eq(relayerDeployments.id, mine.id));
      return { reserved: true };
    }
    await tx.insert(relayerDeployments).values({ safeId: p.safeId, chainId: p.chainId, creator: p.creator.toLowerCase(), estimatedWei: p.estimateWei.toString(), leaseExpiresAt: lease, createdAt: p.now });
    return { reserved: true };
  });
}

/** Read-only view for the Review line (counts only, no estimate, nothing reserved). The real guard is `reserveSponsorship`. */
export async function sponsorshipFor(db: Db, p: { safeId: number | null; creator?: string; chainId: number; budget: SponsorshipBudget; now: Date }): Promise<SponsorshipDecision> {
  const n = async (where: SQL | undefined) => (await db.select({ n: count() }).from(relayerDeployments).where(where))[0]?.n ?? 0;
  const day = gte(relayerDeployments.createdAt, startOfUtcDay(p.now));
  const [spent] = await db.select({ v: sql<string>`coalesce(sum(coalesce(${relayerDeployments.costWei}, ${relayerDeployments.estimatedWei})), 0)` }).from(relayerDeployments).where(day);
  return decideSponsorship({
    chainId: p.chainId, budget: p.budget, dailySpentWei: BigInt(spent?.v ?? 0),
    perSafeUsed: p.safeId === null ? 0 : await n(eq(relayerDeployments.safeId, p.safeId)),
    perCreatorUsed: p.creator ? await n(eq(relayerDeployments.creator, p.creator.toLowerCase())) : 0,
    dailyUsed: await n(day),
  });
}

/** The decisions that need no database or estimate (network not sponsored, budget off). */
export function sponsoredNetwork(chainId: number, budget: SponsorshipBudget): SponsorshipDecision {
  return decideSponsorship({ chainId, budget, perSafeUsed: 0, dailyUsed: 0 });
}

const LOCK_KEY = 7_340_101;
