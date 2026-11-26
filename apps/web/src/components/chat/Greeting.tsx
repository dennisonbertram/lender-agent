"use client";
// The chat's opening greeting and starter chips from live data (BP-09).
import Link from "next/link";
import { useGreeting } from "@/client/blocks";
import { useProposals } from "@/client/proposals";
import { actionLabel, describe } from "@/components/proposals/review-state";
import { Button } from "@/components/ui/button";
import { LimitWhy } from "@/components/blocks/LimitWhy";
import { AsOf } from "./live/AsOf";

export type GreetingProps = { safeAddress: string; onSend: (text: string) => void; disabled?: boolean; contextualHelpOnly?: boolean };

export function Greeting({ safeAddress, onSend, disabled, contextualHelpOnly = false }: GreetingProps) {
  const q = useGreeting(safeAddress);
  // A co-signer opening the chat first needs to know a plan waits for them, not to start a new loan (chat-09).
  const open = useProposals(safeAddress, { open: true });
  const proposals = Array.isArray(open.data) ? open.data.filter((p) => p.stage === "queued" || p.stage === "sending") : [];
  // Prefer a proposal this owner can act on over a newer transaction blocked behind it.
  const actionable = proposals.find((p) => p.stage === "queued" && p.state !== "blocked" && !p.blockedBy?.length && (p.canSign || p.canSend));
  const waiting = actionable ?? proposals[0];
  const greeting = q.isError ? undefined : q.data;
  const urgentFix = greeting?.chips.find((chip) => chip.startsWith("Fix my "));
  if (contextualHelpOnly && !waiting && !urgentFix) {
    return <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => onSend("How does this work?")}>How does this work?</Button></div>;
  }
  const prioritizeUrgentFix = !!waiting && !actionable && !!urgentFix;
  const waitingStatus = waiting ? describe(waiting, { phase: "idle", lastSignerSends: true }) : undefined;
  if (!greeting && !waiting && !q.isError) return null;
  return (
    <div className="flex flex-col gap-2">
      {q.isError && !contextualHelpOnly && <div className="flex flex-col items-start gap-2"><p role="alert" className="text-sm">I couldn't check your Safe's balances to prepare a borrowing offer. Try again before adding funds.</p><Button size="sm" variant="outline" onClick={() => void q.refetch()}>Try again</Button></div>}
      {greeting && (!contextualHelpOnly || urgentFix) && <>
        <p className="text-sm">{greeting.text}</p>
        {!contextualHelpOnly && <LimitWhy why={greeting.why} />}
        {!contextualHelpOnly && <AsOf readAt={greeting.readAt} blockNumber={greeting.blockNumber} />}
      </>}
      {waiting && prioritizeUrgentFix ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/10">
          <span>{waiting.stage === "sending" ? waiting.sentence : waitingStatus?.headline}</span>
          {waiting.stage === "queued" && waiting.threshold !== undefined && <span className="text-muted-foreground">{waiting.signedCount} of {waiting.threshold} approved</span>}
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onSend(urgentFix!)}>{urgentFix}</Button>
        </div>
      ) : waiting ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/10">
          <span>{waiting.stage === "sending" ? waiting.sentence : waitingStatus?.headline}</span>
          {waiting.stage === "queued" && waiting.threshold !== undefined && <span className="text-muted-foreground">{waiting.signedCount} of {waiting.threshold} approved</span>}
          <Link href={waiting.stage === "sending" ? waiting.links.queue : `/s/${safeAddress}/proposals/${waiting.id}`} className="inline-flex shrink-0 items-center font-medium underline underline-offset-2 pointer-coarse:min-h-11">{waiting.stage === "sending" ? "Check Safe queue" : waitingStatus ? actionLabel(waitingStatus) : "Review"}</Link>
        </div>
      ) : greeting ? <div className="flex flex-wrap gap-2">
        {greeting.chips.filter((c) => !contextualHelpOnly || c === "How does this work?" || c.startsWith("Fix my ")).map((c) => <Button key={c} size="sm" variant="outline" disabled={disabled} onClick={() => onSend(c)}>{c}</Button>)}
      </div> : null}
    </div>
  );
}
