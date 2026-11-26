"use client";
// The one-line form of a proposal: a plan that is shown elsewhere (the page) or is over (VC-07).
import type { ReactNode } from "react";
import Link from "next/link";
import type { ProposalStage } from "@/shared/types";

/** The one table of status words: the page header, its badge and the stub all use it (H5). */
export function statusWord(stage: ProposalStage, needsSignatures = 1): string {
  switch (stage) {
    case "draft":
    case "sending": return "Draft";
    case "queued": return needsSignatures === 0 ? "Ready to run in Safe" : "Waiting for signatures";
    case "executed": return "Done";
    case "failed": return "Didn't go through";
    case "rejected": return "Rejected";
    case "replaced": return "Replaced";
    case "stale": return "Out of date";
    case "stopped": return "Stopped";
    case "not_sent": return "Not sent";
  }
}

export const statusTone = (stage: ProposalStage): "warning" | "success" | "destructive" | "muted" =>
  stage === "executed" ? "success" : stage === "failed" ? "destructive" : stage === "draft" || stage === "sending" || stage === "queued" ? "warning" : "muted";

const linkClass = "inline-flex shrink-0 items-center underline underline-offset-2 pointer-coarse:min-h-11";

export function ProposalStub({ title, status, href, linkText, onAction }: { title: string; status: ReactNode; href?: string; linkText?: string; onAction?: () => void }) {
  return (
    <div data-slot="proposal-stub" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/10">
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground" />
      <span className="line-clamp-2 min-w-0 flex-1 basis-40 sm:basis-0" title={title}>{title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
      {href && linkText && <Link href={href} className={linkClass}>{linkText}</Link>}
      {onAction && linkText && <button type="button" onClick={onAction} className={linkClass}>{linkText}</button>}
    </div>
  );
}
