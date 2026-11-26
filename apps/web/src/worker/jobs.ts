// The job registry and the jobs themselves.
import type { Db } from "@/server/db/client";
import type { ChainReader } from "@/server/chain/reader";
import { followOpenProposals } from "@/server/proposals/follow";
import { runMonitorTick, MONITOR_INTERVAL_MS } from "@/server/monitor/tick";
import { relayerBalanceJob } from "@/server/safe-create/alerts";
import { notifyQueuedProposals } from "@/server/proposals/notify-cosigners";
import { markStaleAll } from "@/server/proposals/stale";
import { depositJob } from "@/server/deposits/poll";
import { runMovesTick } from "@/server/moves/service";
import type { Services } from "@/server/services";
import { checkWorkerHealth, workerStallLimitMs } from "./health";

export type JobContext = {
  db: Db;
  reader: ChainReader;
  services?: Services;
  now: Date;
  log: (message: string, detail?: unknown) => void;
};
export type Job = { name: string; intervalMs: number; run(ctx: JobContext): Promise<void> };

const registry = new Map<string, Job>();
export function registerJob(job: Job): void {
  registry.set(job.name, job);
}
export const jobs = (): Job[] => [...registry.values()];
/** Tests only. */
export const clearJobs = () => registry.clear();

/** Monitor tick (BP-18): a snapshot per loan of every Safe with the agent added; interval is MONITOR_INTERVAL_MS (D-09). */
export const monitorJob: Job = {
  name: "monitor",
  intervalMs: MONITOR_INTERVAL_MS,
  async run({ db, reader, services, now, log }) {
    await runMonitorTick({ db, reader, services, now, log, lenders: services?.lenders });
  },
};

/** Raises or resolves the `worker_stalled` alert even when only another worker instance is alive. */
export const workerHealthJob: Job = {
  name: "worker-health",
  intervalMs: 60_000,
  async run({ db, now }) {
    await checkWorkerHealth(db, { now, limitMs: workerStallLimitMs() });
  },
};

/**
 * Open proposals (BP-15, BP-16): follow each queued or sending proposal through the Transaction
 * Service and chain, then recheck staleness. Polling, not webhooks (D-08). About 30 s (proposed).
 */
export const proposalsJob: Job = {
  name: "proposals",
  intervalMs: Number(process.env.PROPOSAL_POLL_MS) || 30_000,
  async run({ db, services, log }) {
    if (!services) throw new Error("proposals job needs the service container");
    await followOpenProposals(db, services);
    await markStaleAll(db, services);
    await notifyQueuedProposals({ db, reader: services.reader, log }); // never throws
  },
};

/** Moves (BP-37, BP-38): expire a stale quote and re-draft, follow the transfer, and draft the loan once the funds have arrived on-chain. Polling only; the aggregator has no webhooks (M0-7). */
export const movesJob: Job = {
  name: "moves",
  intervalMs: Number(process.env.MOVES_POLL_MS) || 30_000,
  async run({ db, services }) {
    if (!services) throw new Error("moves job needs the service container");
    await runMovesTick(db, services);
  },
};

registerJob(monitorJob);
registerJob(proposalsJob);
registerJob(depositJob);
registerJob(movesJob); // E9
registerJob(workerHealthJob);
registerJob(relayerBalanceJob); // E7
