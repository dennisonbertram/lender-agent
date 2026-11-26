"use client";

import { Fragment } from "react";
import { fmt, usd } from "@/lib/format";
import { NetworkChip } from "@/components/common";
import { MIN_LOAN } from "@/lib/loan-math";
import { Button } from "@/components/ui/button";
import { blockCard } from "./card";

/** One asset the Safe holds on one network. `max` is the most it can borrow against it at Balanced safety. Rows come from `holdingRows` in `@/lib/block-helpers`. */
export type HoldingRowData = { network: string; asset: string; amount: number; value: number; max: number };

/** Rows must be sorted by network so each network's chip shows once. */
/** `onPlan` posts the plan card for the row's own max (the figure the row shows), so the amount never comes from anywhere else. */
export function HoldingsBlock({ rows, onSend, onPlan }: { rows: HoldingRowData[]; onSend: (text: string) => void; onPlan?: (row: HoldingRowData, cash: number) => void }) {
  return (
    <div className={blockCard}>
      <p className="font-medium">What you can borrow against</p>
      {rows.length === 0 && <p className="text-muted-foreground">This Safe holds no ETH or wstETH yet. Add some and I can plan a loan.</p>}
      <ul className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <Fragment key={`${r.network}:${r.asset}`}>
          {(i === 0 || rows[i - 1].network !== r.network) && <li className="-mb-1"><NetworkChip id={r.network} /></li>}
          <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <div>{fmt(r.amount, 2)} {r.asset} <span className="text-muted-foreground">· {usd(r.value)}</span></div>
              <div className="text-xs text-muted-foreground">{r.max >= MIN_LOAN ? `Borrow up to ${usd(r.max)} at Balanced safety` : `Too little to borrow ${usd(MIN_LOAN)} safely`}</div>
            </div>
            {r.max >= MIN_LOAN && <Button size="sm" variant="outline" onClick={() => { const cash = Math.min(10000, r.max); if (onPlan) onPlan(r, cash); else onSend(`Plan ${usd(cash)} with ${r.asset} on ${r.network}`); }}>Plan with {r.asset}</Button>}
          </li>
          </Fragment>
        ))}
      </ul>
    </div>
  );
}
