import { loanHF } from "@/data";
import { statusSentence } from "@/lib/loan-copy";
import { PRICES } from "@/data";
import { maxCashSafe } from "@/lib/cash-plan";
import { DEFAULT_LEVELS, MIN_LOAN, healthStatus, levelsOf, maxPriceDrop } from "@/lib/loan-math";
import { useApp } from "@/store";
import { StatusPill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { blockCard } from "./card";

export function StatusBlock() {
  const { safe, loans, thresholds, go, postBlock } = useApp();
  const max = maxCashSafe(safe, PRICES, DEFAULT_LEVELS.warn);
  if (loans.length === 0) {
    return (
      <div className={blockCard}>
        <p>You have no loans yet.</p>
        {max >= MIN_LOAN
          ? <Button size="sm" className="self-start" onClick={() => postBlock({ kind: "plan", cash: Math.min(10000, max) })}>Plan a loan</Button>
          : <p className="text-muted-foreground">Add funds to plan a loan.</p>}
      </div>
    );
  }
  const rows = loans.map((loan) => { const hf = loanHF(loan), t = levelsOf(thresholds, loan.id); return { loan, hf, status: healthStatus(hf, t.warn, t.act) }; });
  const worst = rows.reduce((w, r) => (r.hf < w.hf ? r : w));
  return (
    <div className={blockCard}>
      <p className="font-medium">{statusSentence(rows.map((r) => r.status), worst.loan.venue)}</p>
      <ul className="flex flex-col gap-1">
        {rows.map(({ loan, hf, status }) => (
          <li key={loan.id}>
            <button type="button" aria-label={`Open ${loan.venue} loan`} onClick={() => go({ name: "loan", id: loan.id })} className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg p-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
              <span className="min-w-0">
                <span className="block">{loan.venue}</span>
                <span className="block text-xs text-muted-foreground">can fall {Math.round(maxPriceDrop(hf) * 100)}%</span>
              </span>
              <StatusPill s={status} hf={hf} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
