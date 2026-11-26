"use client";
// The move card (BP-36, BP-37): step 1 of 2. Presentational: the move line (no fee), why it moves, the one fees line, the
// steps and the outcome, then "Send move to Safe (step 1 of 2)". Once the quote ran out the card reads "Out of date".
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { MoveView } from "@/server/moves/service";

export const SEND_MOVE_LABEL = "Send move to Safe (step 1 of 2)";

export function MoveCard({ move: m, onSend, sending, error, children }: { move: MoveView; onSend?: () => void; sending?: boolean; error?: string | null; children?: ReactNode }) {
  const stopped = m.outOfDate || m.status === "closed";
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10", stopped && "gap-1")}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{m.title}</span>
        {m.outOfDate && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">Out of date</span>}
      </div>
      {!stopped && (
        <>
          <p>{m.moveLine}</p>
          {m.reason && <p className="text-muted-foreground">{m.reason}</p>}
          <p>{m.outcome}</p>
          <ol className="flex flex-col gap-1">
            {m.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">{i + 1}</span>
                <span className="min-w-0">{s}</span>
              </li>
            ))}
          </ol>
          {m.feesLine && <p className="text-xs text-muted-foreground">{m.feesLine}</p>}
        </>
      )}
      <p role="status" className="text-sm text-foreground">{m.sentence}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {(m.canSend || children) && (
        <div className="flex flex-wrap items-center gap-2">
          {m.canSend && <Button disabled={sending || !onSend} onClick={onSend}>{SEND_MOVE_LABEL}</Button>}
          {children}
        </div>
      )}
    </div>
  );
}
