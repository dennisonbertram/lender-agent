"use client";
// Fix options and the draft for an at-risk loan (BP-22, BP-23). Presentational: the figures and sentences come
// from the server (G1); nothing here computes health. Wording follows the mockup's AlertCard (r15, VC-01).
import { useRef } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { needsSignatures } from "@/lib/loan-copy";
import { FixOptionRow, focusFirstOption } from "./FixOptionRow";
import type { FixDraftView, FixOptions, FixState } from "@/client/fixes";

const card = "flex w-full min-w-0 flex-col gap-3 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10";
const hf2 = (n: number | null) => (n === null ? "No debt" : n.toFixed(2));

export type FixCardProps = {
  options: FixOptions | null;
  draft: FixDraftView | null;
  state: FixState;
  /** Signatures the Safe needs. */
  sigs: number;
  agentOn: boolean;
  busy?: boolean;
  error?: string | null;
  onPick: (option: "coll" | "repay" | "both") => void;
  onSend: (draftId: string) => void;
  /** "Open in Safe" for a sent fix. */
  safeLink?: string;
  /** Inside the loan page's single red block: no red wrapper or title of its own, and the options stay visible next to a draft. */
  embedded?: boolean;
};

export function FixCard({ options, draft, state, sigs, agentOn, busy, error, onPick, onSend, safeLink, embedded }: FixCardProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const replaced = state.replaced.length > 0;
  const sent = draft?.state === "sent";
  const note = options?.note;
  const rows = options && !sent && (
    <div className={embedded ? "flex flex-col gap-2" : cn(card, "bg-destructive/10 ring-1 ring-destructive/30")} data-testid="fix-options">
      {!embedded && (
        <div className="flex items-start gap-2 font-medium text-destructive-text">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">Fix options for your {options.lender} loan</span>
        </div>
      )}
      {replaced && !draft && <p className="text-xs text-muted-foreground">Your earlier fix was replaced because the loan changed. Pick again.</p>}
      <div className="flex flex-col gap-2">
        {options.options.map((o) => (
          <FixOptionRow
            key={o.k} label={o.label} chosen={draft?.option === o.k} disabled={o.short || !agentOn || !!busy}
            recommended={o.recommended && agentOn} onClick={() => onPick(o.k)}
            sub={`${o.sub}${o.short ? "" : ` · ${needsSignatures(sigs)}`}`}
          />
        ))}
        {agentOn && note && !draft && <p className="text-xs text-muted-foreground">{note}</p>}
        {agentOn && options.options.some((o) => o.short) && <p className="text-xs text-muted-foreground">Greyed options need more than this Safe holds. Move funds into the Safe first, or pick another option.</p>}
      </div>
      {!agentOn && <p className="text-xs text-muted-foreground">Add the agent to this Safe to draft a fix.</p>}
      {!draft && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
  const draftCard = draft && (
    <div className={cn(card, embedded && "bg-card")} data-testid="fix-draft">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{embedded ? `Your fix: ${draft.title}` : draft.title}</span>
        {sent && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">Sent to Safe</span>}
      </div>
      <ol className="flex flex-col gap-1">
        {draft.steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">{i + 1}</span>
            <span className="min-w-0">{s}</span>
          </li>
        ))}
        <li className="pl-7 text-xs text-muted-foreground">{draft.testRunLine}</li>
      </ol>
      <p>Health <span className="font-medium">{hf2(draft.healthBefore)} → {hf2(draft.healthAfter)}</span></p>
      {!sent && <p className="text-xs">{draft.stillNeeds}</p>}
      {draft.urgentNote && (
        <details className="text-xs">
          <summary className="cursor-pointer">Another proposal is already waiting</summary>
          <p role="note" className="mt-1 rounded-lg bg-muted p-2" data-testid="urgent-note">{draft.urgentNote}</p>
        </details>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {sent
        ? safeLink && <a href={safeLink} target="_blank" rel="noreferrer" className="self-start text-sm underline underline-offset-2">Open in Safe</a>
        : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!draft.canSend || busy} onClick={() => onSend(draft.id)}>Send to Safe</Button>
            {options && <Button variant="link" size="sm" onClick={() => focusFirstOption(rootRef.current)}>Choose another</Button>}
          </div>
        )}
    </div>
  );
  if (!draftCard && !rows) return replaced ? <FixReplaced /> : null;
  if (!rows) return draftCard;
  if (!draftCard) return rows;
  return <div ref={rootRef} className="flex flex-col gap-3">{rows}{draftCard}</div>;
}

/** The older card after a newer draft took its place (BP-22). */
export function FixReplaced() {
  return (
    <div className={cn(card, "gap-1 opacity-60")} data-testid="fix-replaced">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">Earlier fix</span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">Replaced</span>
      </div>
    </div>
  );
}
