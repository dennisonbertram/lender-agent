"use client";

import { usd } from "@/lib/format";
import type { CompareResponse } from "@/server/blocks/compare";
import { StatusPill } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { blockCard } from "./card";

export type CompareBlockProps = Pick<CompareResponse, "cash" | "asset" | "network" | "rows"> & {
  /** Venue id of the cheapest row that can lend: it is labelled and carries the one primary button. */
  bestId?: string | null;
  /** "Plan this" on a feasible row: the caller posts a plan block for that lender. */
  onUse: (venueId: string) => void;
  disabled?: boolean;
};

const WORD = ["", "", "both", "all three"];

/** One row per lender, sorted by quoted rate by the server. Rows that cannot lend are muted with the server's reason (r33). Every figure is printed as sent.
 * Facts every lender shares (how far the price can fall, health, adding to a loan) are said once above the list (VC-08). */
export function CompareBlock({ cash, asset, network, rows, bestId, onUse, disabled }: CompareBlockProps) {
  const feasible = rows.filter((r) => r.feasible);
  const first = feasible[0];
  const shared = feasible.length >= 2 && feasible.length <= 3 && first.dropPct !== undefined && first.status !== undefined
    && feasible.every((r) => r.dropPct === first.dropPct && r.status === first.status && !!r.adding === !!first.adding);
  return (
    <div className={blockCard}>
      <p className="font-medium">{usd(cash)} against your {asset} on {network}, Balanced safety</p>
      {shared && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>Same with {WORD[feasible.length]}: {asset} can fall {first.dropPct}% before the lender can sell it</span>
          <StatusPill s={first.status!} />
          {first.adding && <span>Adds to your loan</span>}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.venueId} className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", !r.feasible && "text-muted-foreground")}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 font-medium">
                <span>{r.lender}{r.apr !== null && <span className="font-normal"> · {r.apr}%</span>}</span>
                {r.feasible && r.venueId === bestId && <Badge variant="secondary">Lowest rate</Badge>}
              </div>
              {r.feasible ? (
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {r.yearly !== undefined && <span>About {usd(r.yearly)} in interest a year</span>}
                  {!shared && r.dropPct !== undefined && <span>Price can fall {r.dropPct}%</span>}
                  {!shared && r.status && <StatusPill s={r.status} />}
                  {!shared && r.adding && <span>Adds to your loan</span>}
                </div>
              ) : r.reason && <div className="text-xs">{r.reason}</div>}
            </div>
            {r.feasible && <Button size="sm" variant={r.venueId === bestId ? "default" : "outline"} disabled={disabled} aria-label={`Plan this with ${r.lender}`} onClick={() => onUse(r.venueId)}>Plan this</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
