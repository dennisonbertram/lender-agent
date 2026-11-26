// Per-job locks in `worker_locks`. One atomic statement decides who runs a due job; a lock expires
// after its TTL so a crashed worker does not block the job forever.
import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";

export const DEFAULT_LOCK_TTL_MS = 5 * 60_000;

/** `db.execute()` gives `{ rows }` on PGlite but a bare row array on postgres-js; accept both. */
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/**
 * Try to take the lock for `job`. Succeeds only when the lock is free or expired AND the job is due
 * (never run, or last run at least `intervalMs` ago). Checking "due" in the same statement means two
 * workers cannot both run one due job, even if one finishes between the other's check and its attempt.
 */
export async function acquireLock(
  db: Db,
  p: { job: string; workerId: string; now: Date; ttlMs?: number; intervalMs?: number },
): Promise<boolean> {
  const until = new Date(p.now.getTime() + (p.ttlMs ?? DEFAULT_LOCK_TTL_MS)).toISOString();
  const dueBefore = new Date(p.now.getTime() - (p.intervalMs ?? 0)).toISOString();
  const now = p.now.toISOString();
  const res = await db.execute(sql`
    INSERT INTO worker_locks (job, locked_by, locked_until)
    VALUES (${p.job}, ${p.workerId}, ${until}::timestamptz)
    ON CONFLICT (job) DO UPDATE
      SET locked_by = excluded.locked_by, locked_until = excluded.locked_until
      WHERE worker_locks.locked_until <= ${now}::timestamptz
        AND (worker_locks.last_run_at IS NULL OR worker_locks.last_run_at <= ${dueBefore}::timestamptz)
    RETURNING job, locked_by`);
  return rowsOf<{ locked_by: string }>(res).some((r) => r.locked_by === p.workerId);
}

/** Release the lock and record when the run started (the schedule counts from it). */
export async function releaseLock(db: Db, p: { job: string; workerId: string; now: Date; lastRunAt: Date }): Promise<void> {
  await db.execute(sql`
    UPDATE worker_locks SET locked_until = ${p.now.toISOString()}::timestamptz, last_run_at = ${p.lastRunAt.toISOString()}::timestamptz
    WHERE job = ${p.job} AND locked_by = ${p.workerId}`);
}
