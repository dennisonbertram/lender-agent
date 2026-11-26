"use client";

import { statusSentence } from "@/lib/loan-copy";
import { MIN_LOAN, type HealthStatus } from "@/lib/loan-math";
import { StatusPill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { usd } from "@/lib/format";
import { blockCard } from "./card";

export type StatusLoan = { id: string; venue: string; hf: number; status: HealthStatus; /** Percent the collateral can fall before liquidation, rounded. */ dropPct: number; /** Yearly borrow rate in percent, and what it costs over a year; null or absent when unknown. */ apr?: number | null; yearly?: number | null };

/** `loans` are the Safe's loans with figures from the server. `maxCash` is the most the Safe can safely borrow (for the empty case). */
export function StatusBlock({ loans, maxCash, onOpenLoan, onSend }: { loans: StatusLoan[]; maxCash: number; onOpenLoan: (id: string) => void; onSend: (text: string) => void }) {
  if (loans.length === 0) {
    return (
      <div className={blockCard}>
        <p>You have no loans yet.</p>
        {maxCash >= MIN_LOAN
          ? <Button size="sm" className="self-start" onClick={() => onSend("Plan a loan")}>Plan a loan</Button>
          : <p className="text-muted-foreground">Add funds to plan a loan.</p>}
      </div>
    );
  }
  const worst = loans.reduce((w, r) => (r.hf < w.hf ? r : w));
  return (
    <div className={blockCard}>
      <p className="font-medium">{statusSentence(loans.map((r) => r.status), worst.venue)}</p>
      <ul className="flex flex-col gap-1">
        {loans.map(({ id, venue, hf, status, dropPct, apr, yearly }) => (
          <li key={id}>
            <button type="button" aria-label={`Open ${venue} loan`} onClick={() => onOpenLoan(id)} className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg p-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
              <span className="min-w-0">
                <span className="block">{venue}</span>
                <span className="block text-xs text-muted-foreground">can fall {dropPct}%</span>
                {apr != null && yearly != null && <span className="block text-xs text-muted-foreground">{+apr.toFixed(1)}% · about {usd(yearly, 0)} a year</span>}
              </span>
              <StatusPill s={status} hf={hf} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
