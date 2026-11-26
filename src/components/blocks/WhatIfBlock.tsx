import { useState } from "react";
import { PRICES, usd } from "@/data";
import { hypotheticalLoan, whatIfRows } from "@/lib/block-helpers";
import { resolveHolding } from "@/lib/cash-plan";
import { balancesOn } from "@/lib/networks";
import { DEFAULT_LEVELS, statusLabel } from "@/lib/loan-math";
import type { UIBlock } from "@/lib/blocks";
import { useApp } from "@/store";
import { StatusPill } from "@/components/common";
import { blockCard } from "./card";

export function WhatIfBlock({ block }: { block: Extract<UIBlock, { kind: "whatif" }> }) {
  const { loans, safe, thresholds } = useApp();
  const [pct, setPct] = useState(20);
  const cash = block.cash ?? 10000;
  const held = resolveHolding(safe, PRICES, cash, DEFAULT_LEVELS.warn, { asset: block.asset });
  const asset = block.asset ?? (loans.length ? "ETH" : held.asset);
  const drop = pct / 100;
  const hyp = loans.length ? null : hypotheticalLoan(cash, asset, drop, balancesOn(safe, held.network), held.network);
  return (
    <div className={blockCard}>
      <label className="flex flex-col gap-2">
        <span className="font-medium">If {asset} falls {pct}%</span>
        <input type="range" min={0} max={60} step={5} value={pct} onChange={(e) => setPct(+e.target.value)} className="w-full accent-foreground" aria-label={`${asset} price fall, percent`} />
      </label>
      <p className="text-xs text-muted-foreground">{asset} would go from {usd(PRICES[asset])} to {usd(PRICES[asset] * (1 - drop))}. Prices are sample data.</p>
      {loans.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {whatIfRows(loans, asset, drop, thresholds).map(({ loan, hf, status }) => (
            <li key={loan.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span>{loan.venue} <span className="text-muted-foreground">· {loan.collAsset}</span></span>
              <StatusPill s={status} hf={hf} />
            </li>
          ))}
        </ul>
      ) : hyp ? (
        <div className="flex flex-col gap-1">
          <p>A {usd(cash)} loan would be: <span className="font-medium">{statusLabel[hyp.status]}</span></p>
          <p className="text-xs text-muted-foreground">It is liquidated if {asset} falls below {usd(hyp.liqPrice)}.</p>
        </div>
      ) : (
        <p className="text-muted-foreground">This Safe cannot safely back {usd(cash)} with {asset}.</p>
      )}
    </div>
  );
}
