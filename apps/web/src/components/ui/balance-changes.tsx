import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BalanceChange = { label: string; hint?: ReactNode; amount: string; tone: "in" | "out" };

/** What leaves and what arrives in the Safe: amounts right-aligned, "in" in the success colour. */
export function BalanceChanges({ rows, className }: { rows: BalanceChange[]; className?: string }) {
  return (
    <ul data-slot="balance-changes" className={cn("flex flex-col divide-y divide-border rounded-lg ring-1 ring-border", className)}>
      {rows.map((r) => (
        <li key={r.label} className="flex items-start justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{r.label}</p>
            {r.hint && <p className="text-xs text-muted-foreground">{r.hint}</p>}
          </div>
          <p data-tone={r.tone} className={cn("shrink-0 text-right text-sm font-semibold tabular-nums", r.tone === "in" ? "text-success-text" : "text-foreground")}>{r.amount}</p>
        </li>
      ))}
    </ul>
  );
}
