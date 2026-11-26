// Runs due jobs under their locks, one tick row per run. An error in one job never stops the next.
import type { Db } from "@/server/db/client";
import { schema } from "@/server/db/client";
import type { ChainReader } from "@/server/chain/reader";
import type { Services } from "@/server/services";
import { jobs as registeredJobs, type Job } from "./jobs";
import { acquireLock, DEFAULT_LOCK_TTL_MS, releaseLock } from "./locks";

export type RunDeps = {
  db: Db;
  reader: ChainReader;
  /** The service container (Safe service, signer, …) for jobs that need more than chain reads. */
  services?: Services;
  workerId: string;
  now: Date | (() => Date);
  jobs?: Job[];
  ttlMs?: number;
  log?: (message: string, detail?: unknown) => void;
};
export type RunResult = { job: string; status: "ok" | "failed" | "skipped" };

const defaultLog = (message: string, detail?: unknown) => console.error(`[worker] ${message}`, detail ?? "");

export async function runDueJobs(deps: RunDeps): Promise<RunResult[]> {
  const clock = typeof deps.now === "function" ? deps.now : () => deps.now as Date;
  const log = deps.log ?? defaultLog;
  const results: RunResult[] = [];
  for (const job of deps.jobs ?? registeredJobs()) {
    const startedAt = clock();
    let got = false;
    try {
      got = await acquireLock(deps.db, { job: job.name, workerId: deps.workerId, now: startedAt, ttlMs: deps.ttlMs ?? DEFAULT_LOCK_TTL_MS, intervalMs: job.intervalMs });
    } catch (e) {
      log(`lock for ${job.name} failed`, e);
    }
    if (!got) {
      results.push({ job: job.name, status: "skipped" });
      continue;
    }
    let error: string | null = null;
    try {
      await job.run({ db: deps.db, reader: deps.reader, services: deps.services, now: startedAt, log });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log(`job ${job.name} failed`, e);
    }
    try {
      const finishedAt = clock();
      await deps.db.insert(schema.workerTicks).values({ job: job.name, workerId: deps.workerId, startedAt, finishedAt, ok: error === null, error });
      await releaseLock(deps.db, { job: job.name, workerId: deps.workerId, now: finishedAt, lastRunAt: startedAt });
    } catch (e) {
      log(`recording tick for ${job.name} failed`, e);
    }
    results.push({ job: job.name, status: error === null ? "ok" : "failed" });
  }
  return results;
}

/** Poll for due jobs every `pollMs`. `stop()` waits for the run in flight. */
export function startLoop(deps: Omit<RunDeps, "now"> & { pollMs?: number }): { stop: () => Promise<void> } {
  let running: Promise<unknown> | null = null;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = runDueJobs({ ...deps, now: () => new Date() })
      .catch((e) => (deps.log ?? defaultLog)("tick failed", e))
      .finally(() => (running = null));
  };
  tick();
  const timer = setInterval(tick, deps.pollMs ?? 5_000);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
