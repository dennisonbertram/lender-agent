// Is the worker alive? No successful `monitor` tick for longer than the limit raises one open
// `worker_stalled` operator alert; the chat header then stops saying "Watching" (r14).
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/server/db/client";

export const MONITOR_JOB = "monitor";
export const WORKER_STALLED = "worker_stalled";
export const workerStallLimitMs = (): number => Number(process.env.WORKER_STALL_LIMIT_MS) || 15 * 60_000;

export type WorkerHealth = { watching: boolean; lastOkAt: Date | null };

export async function checkWorkerHealth(db: Db, p: { now: Date; limitMs: number }): Promise<WorkerHealth> {
  const [last] = await db
    .select({ at: schema.workerTicks.finishedAt, startedAt: schema.workerTicks.startedAt })
    .from(schema.workerTicks)
    .where(and(eq(schema.workerTicks.job, MONITOR_JOB), eq(schema.workerTicks.ok, true)))
    .orderBy(desc(schema.workerTicks.startedAt))
    .limit(1);
  const lastOkAt = last ? (last.at ?? last.startedAt) : null;
  const watching = lastOkAt !== null && p.now.getTime() - lastOkAt.getTime() <= p.limitMs;
  if (!watching) {
    const since = lastOkAt ? `since ${lastOkAt.toISOString()}` : "ever";
    // One statement, so two callers cannot both insert while none is open.
    await db.execute(sql`
      INSERT INTO operator_alerts (kind, text)
      SELECT ${WORKER_STALLED}, ${`No successful monitor tick ${since} (limit ${Math.round(p.limitMs / 1000)} s).`}
      WHERE NOT EXISTS (SELECT 1 FROM operator_alerts WHERE kind = ${WORKER_STALLED} AND resolved_at IS NULL)`);
  } else {
    await db
      .update(schema.operatorAlerts)
      .set({ resolvedAt: p.now })
      .where(and(eq(schema.operatorAlerts.kind, WORKER_STALLED), isNull(schema.operatorAlerts.resolvedAt)));
  }
  return { watching, lastOkAt };
}
