import { attentionCounts, attentionLine } from "@/lib/loan-copy";
import type { HealthStatus } from "@/lib/loan-math";
import { timeAgo } from "@/lib/time-ago";

/** The one table of words for "is the agent watching my loan" (VC-01). */
export type WatchState = "watching" | "starting" | "lagging" | "off" | "none";

export function watchState(i: { agentOn: boolean; watching: boolean; failing: boolean; starting: boolean; loans: number }): WatchState {
  if (!i.agentOn) return "off";
  if (i.watching) return "watching";
  if (i.starting) return "starting";
  if (i.loans === 0) return "none";
  return i.failing ? "lagging" : "starting";
}

export const STARTING_LINE = "Getting ready. First check in about a minute.";
export const NO_CHECK_LINE = "Not checked yet";

/** No check has run yet: "Not checked yet" once checks are failing, "Getting ready" only while the first one is still scheduled. */
export function firstCheckLine(failing: boolean): string {
  return failing ? NO_CHECK_LINE : STARTING_LINE;
}

function watchingLine(statuses: HealthStatus[], lastCheckAt: string | null, now: number, pending = 0): string {
  const n = statuses.length;
  if (n === 0) return pending ? WAITING_LINE : "Ready. No loans to watch yet.";
  const { act } = attentionCounts(statuses);
  return `Watching ${n} ${n === 1 ? "loan" : "loans"}${act ? ` · ${act} ${act === 1 ? "needs" : "need"} action` : ""}${lastCheckAt ? ` · last checked ${timeAgo(Date.parse(lastCheckAt), now)}` : ""}`;
}

export const WAITING_LINE = "The loan hasn't opened yet. The agent starts watching once it does.";

/** Only an open-loan request can lead to a loan entering the watch list. */
export function pendingLoanCount(proposals: readonly { final: boolean; specKind: string }[]): number {
  return proposals.filter((p) => !p.final && p.specKind === "open").length;
}

/** `pending`: open proposals still waiting for signatures (only matters while there are no loans). */
export function watchLine(s: WatchState, i: { statuses: HealthStatus[]; lastCheckAt: string | null; now: number; pending?: number; /** A loan opened recently and the worker is healthy: its first check is still due. */ firstCheckDue?: boolean }): string {
  switch (s) {
    case "watching": return watchingLine(i.statuses, i.lastCheckAt, i.now, i.pending);
    case "starting": return STARTING_LINE;
    // Never "delayed" before a first check was ever due; with no check on record say plainly that none has run (BP-18).
    case "lagging": return i.lastCheckAt ? `Delayed: last check ${timeAgo(Date.parse(i.lastCheckAt), i.now)}` : i.firstCheckDue ? "Checking your loans… first check within a minute" : NO_CHECK_LINE;
    case "off": return "Not watching this Safe";
    case "none": return i.pending ? WAITING_LINE : "Ready. No loans to watch yet.";
  }
}

/** The picker row of a Safe: no lag data exists for other Safes, so only whether the agent is on. */
export function pickerLine(statuses: HealthStatus[], agent: boolean): string {
  return attentionLine(statuses) || (!agent ? "Agent not added" : statuses.length === 0 ? "Agent on · no loans yet" : "Agent on");
}

/** The state of the current Safe's monitor for any screen (loan page, settings, overview): same flags in, same words out. */
export function watchView(i: { agentOn: boolean; watching: boolean; failing?: boolean; starting?: boolean; statuses: HealthStatus[]; lastCheckAt?: string | null; now: number; pending?: number; firstCheckDue?: boolean }): { state: WatchState; line: string } {
  const state = watchState({ agentOn: i.agentOn, watching: i.watching, failing: !!i.failing, starting: !!i.starting, loans: i.statuses.length });
  return { state, line: watchLine(state, { statuses: i.statuses, lastCheckAt: i.lastCheckAt ?? null, now: i.now, pending: i.pending, firstCheckDue: i.firstCheckDue }) };
}

/** The loan page's footer (monitor state of one loan), in the same words as the agent panel. */
export function loanMonitorLine(m: { state: "watching" | "starting" | "failing" | "not_watched"; lastCheckAt: string | null; source?: string | null; firstCheckDue?: boolean }, now: number, clock: (ms: number) => string): string {
  if (m.state === "not_watched") return "Not watched.";
  if (m.state === "failing") return watchLine("lagging", { statuses: [], lastCheckAt: m.lastCheckAt, now, firstCheckDue: m.firstCheckDue });
  if (m.lastCheckAt) return `Last checked ${clock(Date.parse(m.lastCheckAt))}${m.source ? ` · ${m.source}` : ""}.`;
  return firstCheckLine(false);
}
