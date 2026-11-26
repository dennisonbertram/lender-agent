"use client";
// The one proposal card, presentational (BP-28). No sign or approve buttons: signing happens in
// Safe (r28). The owner's Reject button goes in `actions`.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { ProposalView } from "@/server/proposals/view";

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const STOPPED = new Set(["rejected", "stale", "stopped", "replaced", "not_sent", "failed"]);
const LABEL: Record<string, string> = { rejected: "Rejected", replaced: "Replaced", stale: "Out of date", stopped: "Stopped", not_sent: "Not sent", failed: "Failed" };

function HashLine({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(hash); } catch { /* clipboard can be blocked */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/40 p-2 ring-1 ring-border">
      <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
        Match this code in Safe <code title={hash}>{short(hash)}</code>
        <button type="button" onClick={copy} aria-label="Copy the code to match in Safe" className="inline-flex items-center gap-1 underline underline-offset-2">
          {copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
        </button>
      </p>
      <p className="text-xs text-muted-foreground">In Safe, open this transaction and find “Safe transaction hash”. Its first and last characters should match this code. If they don&apos;t, don&apos;t sign: reject it here.</p>
    </div>
  );
}

export function ProposalCard({ proposal: p, actions, focused, hideTitle, loanHref, loanLabel }: {
  proposal: ProposalView; actions?: ReactNode; focused?: boolean;
  /** The page header already shows the title. */
  hideTitle?: boolean;
  /** Where an executed card sends the person on, and the words for it. */
  loanHref?: string; loanLabel?: string;
}) {
  const stopped = STOPPED.has(p.stage);
  const executed = p.stage === "executed";
  const showBody = !stopped && !executed;
  const inSafe = p.inSafe;
  const link = p.links.tx ?? p.links.queue;
  // Signing and executing happen in Safe{Wallet}: the primary control is a link there, never an in-app action (r28).
  const primary = p.stage !== "queued" || p.hashMismatch ? null : p.needsSignatures > 0 ? (p.viewerSigned ? null : "Open Safe to sign") : "Open Safe to execute";
  return (
    <div
      data-focused={focused || undefined}
      className={cn("flex flex-col gap-3 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10", stopped && "gap-1", focused && "ring-2 ring-foreground/40")}
    >
      {!hideTitle && (
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium">{p.title}</span>
          {stopped && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">{LABEL[p.stage]}</span>}
        </div>
      )}
      {showBody && <p>{p.outcome}</p>}
      {showBody && (
        <ol className="flex flex-col gap-1">
          {p.steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">{i + 1}</span>
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ol>
      )}
      {showBody && !!p.safety && <p className="text-xs text-muted-foreground">Safety: {p.safety}</p>}
      {showBody && p.signBy && <p className="text-xs text-muted-foreground">Sign by {new Date(p.signBy).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</p>}
      {showBody && p.testRunLine && <p className="text-xs text-muted-foreground">{p.testRunLine}</p>}
      {!stopped && (
        <div className="flex items-center gap-2">
          <div aria-hidden className="flex flex-1 gap-1">
            {p.segments.map((s, i) => <span key={i} className={cn("h-1 flex-1 rounded-full", executed ? "bg-success" : s === "todo" ? "bg-border" : "bg-foreground")} />)}
          </div>
          {p.countLabel && <span className="shrink-0 text-xs font-medium">{p.countLabel}</span>}
        </div>
      )}
      <p role="status" className="flex items-start gap-2 text-sm text-foreground">
        {executed && <Check className="mt-0.5 size-4 shrink-0 text-success" />}
        {executed && p.doneLine ? p.doneLine : p.sentence}
      </p>
      {p.nextStep && <p className="text-sm font-medium">{p.nextStep}</p>}
      {p.stillQueuedNote && <p className="text-xs text-muted-foreground">{p.stillQueuedNote}</p>}
      {p.hashMismatch && <p role="alert" className="text-xs text-destructive">The stored hash does not match this transaction. Do not sign it; check it in Safe.</p>}
      {p.safeTxHash && inSafe && !executed && <HashLine hash={p.safeTxHash} />}
      {(inSafe || actions || (executed && loanHref)) && (
        <div className="flex flex-wrap items-center gap-2">
          {primary ? (
            <div className="flex w-full flex-col gap-1 sm:w-auto">
              <Button render={<a href={link} target="_blank" rel="noreferrer" />} className="w-full sm:w-auto">{primary}</Button>
              <span className="text-xs text-muted-foreground">Opens Safe{"{Wallet}"} in a new tab.</span>
            </div>
          ) : (
            <>
              {executed && loanHref && <Button render={<Link href={loanHref} />}>{loanLabel ?? "View loan"}</Button>}
              {inSafe && <a href={link} target="_blank" rel="noreferrer" title={p.safeTxHash ?? undefined} className="text-sm underline underline-offset-2">Open in Safe</a>}
            </>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
