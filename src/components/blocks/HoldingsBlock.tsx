import { fmt, usd } from "@/data";
import { Fragment } from "react";
import { NetworkChip } from "@/components/common";
import { holdingRows } from "@/lib/block-helpers";
import { lendersFor } from "@/lib/networks";
import { useApp } from "@/store";
import { MIN_LOAN } from "@/lib/loan-math";
import { Button } from "@/components/ui/button";
import { blockCard } from "./card";

export function HoldingsBlock() {
  const { safe, postBlock } = useApp();
  const rows = holdingRows(safe.balances, (n) => lendersFor(safe, n));
  return (
    <div className={blockCard}>
      <p className="font-medium">What you can borrow against</p>
      {rows.length === 0 && <p className="text-muted-foreground">This Safe holds no ETH, wstETH or WBTC yet. Add some and I can plan a loan.</p>}
      <ul className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <Fragment key={`${r.network}:${r.asset}`}>
          {(i === 0 || rows[i - 1].network !== r.network) && <li className="-mb-1"><NetworkChip id={r.network} /></li>}
          <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <div>{fmt(r.amount, 2)} {r.asset} <span className="text-muted-foreground">· {usd(r.value)}</span></div>
              <div className="text-xs text-muted-foreground">{r.max >= MIN_LOAN ? `Borrow up to ${usd(r.max)} at Balanced safety` : `Too little to borrow ${usd(MIN_LOAN)} safely`}</div>
            </div>
            {r.max >= MIN_LOAN && <Button size="sm" variant="outline" onClick={() => postBlock({ kind: "plan", cash: Math.min(10000, r.max), asset: r.asset, network: r.network })}>Plan with {r.asset}</Button>}
          </li>
          </Fragment>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Prices are sample data.</p>
    </div>
  );
}
