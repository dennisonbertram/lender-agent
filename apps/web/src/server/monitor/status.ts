// What the header and the dashboard say about the monitor (BP-18, r14, r13). Never claims to watch
// unless every watched network's last check succeeded and is recent.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/server/db/client";
import { workerStallLimitMs } from "@/worker/health";
import type { ChainId } from "@/shared/types";

export type MonitorState = "not_watched" | "starting" | "watching" | "failing";
export type MonitorStatus = {
  state: MonitorState;
  /** The most recent check on the watched networks, or null before the first. */
  lastCheckAt: Date | null;
  source: string | null;
  /** Loans found by the last successful checks. */
  loans: number;
};

export async function monitorStatusFor(db: Db, safeId: number, chainIds: ChainId[], now: Date, limitMs = workerStallLimitMs()): Promise<MonitorStatus> {
  const watched = chainIds.length
    ? await db.select({ chainId: schema.safeNetworks.chainId }).from(schema.safeNetworks)
      .where(and(eq(schema.safeNetworks.safeId, safeId), eq(schema.safeNetworks.agentAdded, true), inArray(schema.safeNetworks.chainId, chainIds)))
    : [];
  if (!watched.length) return { state: "not_watched", lastCheckAt: null, source: null, loans: 0 };
  const status = await db.select().from(schema.monitorStatus)
    .where(and(eq(schema.monitorStatus.safeId, safeId), inArray(schema.monitorStatus.chainId, watched.map((w) => w.chainId))));
  const lastCheckAt = status.reduce<Date | null>((m, s) => (!m || s.lastCheckAt > m ? s.lastCheckAt : m), null);
  const source = [...new Set(status.map((s) => s.source))].join(" · ") || null;
  const loans = status.reduce((n, s) => n + s.loanCount, 0);
  if (!status.length) return { state: "starting", lastCheckAt, source, loans };
  const failing = watched.some((w) => {
    const s = status.find((x) => x.chainId === w.chainId);
    return !!s && (s.lastError !== null || now.getTime() - s.lastCheckAt.getTime() > limitMs);
  });
  const unchecked = watched.some((w) => !status.some((x) => x.chainId === w.chainId));
  return { state: failing ? "failing" : unchecked ? "starting" : "watching", lastCheckAt, source, loans };
}
