"use client";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useState } from "react";
import { getJson } from "@/client/http";
import { PROPOSAL_SENT_EVENT } from "@/client/proposals";
import type { ProposalView } from "@/server/proposals/view";
import { useShell } from "@/components/shell/ShellContext";
import { cn } from "@/lib/utils";
import { pendingLoanCount, watchView, type WatchState } from "@/lib/watch-copy";

const DOT: Record<WatchState, string> = { watching: "bg-success", lagging: "bg-warning", starting: "bg-muted-foreground", off: "bg-muted-foreground", none: "bg-muted-foreground" };

function useNow(ms: number, on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

/** The current Safe's watch state and line: the one source for the panel, the overview, the loan page and settings.
 * `pending`: open proposals waiting for signatures (the line differs only while there are no loans). */
export function useWatchStatus(pending = 0): { state: WatchState; line: string } {
  const { agentOn, watching, failing, starting, loans, lastCheckAt, firstCheckDue } = useShell();
  const now = useNow(30_000, true);
  return watchView({ agentOn, watching, failing, starting, statuses: loans.map((l) => l.status), lastCheckAt, now, firstCheckDue, pending: loans.length === 0 ? pending : 0 });
}

/** Open proposals still waiting, from the same cache as the proposals list (read once, no polling of its own). */
function usePendingProposals(address: string, enabled: boolean): number {
  const { data, refetch } = useQuery({
    enabled,
    queryKey: ["proposals", address.toLowerCase(), "list", true],
    queryFn: async () => (await getJson<{ proposals: ProposalView[] }>(`/api/safes/${address}/proposals/list?open=1`)).proposals,
    staleTime: 30_000,
  });
  // A plan just sent is a waiting proposal now.
  useEffect(() => {
    if (!enabled) return;
    const onSent = () => void refetch();
    window.addEventListener(PROPOSAL_SENT_EVENT, onSent);
    return () => window.removeEventListener(PROPOSAL_SENT_EVENT, onSent);
  }, [enabled, refetch]);
  return pendingLoanCount(data ?? []);
}

export function Line({ state, line, className }: { state: WatchState; line: string; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)} title={line}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />
      <span className="truncate">{line}</span>
    </span>
  );
}

function View({ pending, className }: { pending: number; className?: string }) {
  const { state, line } = useWatchStatus(pending);
  return <Line state={state} line={line} className={className} />;
}

function WithPending({ className }: { className?: string }) {
  const { safe, agentOn, loans } = useShell();
  return <View pending={usePendingProposals(safe.address, agentOn && loans.length === 0)} className={className} />;
}

function Current({ className }: { variant: "line" | "row"; className?: string }) {
  // Without a query client (a bare render) the line simply has no pending count.
  return useContext(QueryClientContext) ? <WithPending className={className} /> : <View pending={0} className={className} />;
}

/** The only place the monitor state is worded. Reads the current Safe, or takes `state` + `line` (picker rows of other Safes). */
export function AgentWatchStatus(props: { variant?: "line" | "row"; state?: WatchState; line?: string; className?: string }) {
  if (props.state && props.line) return <Line state={props.state} line={props.line} className={props.className} />;
  return <Current variant={props.variant ?? "line"} className={props.className} />;
}
