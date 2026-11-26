"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import { MIN_LOAN } from "@/lib/loan-math";
import type { WhatIfResponse } from "@/server/blocks/whatif";
import { NetworkChip, StatusPill } from "@/components/common";
import { DEFAULT_DROP, MAX_DROP } from "@/lib/whatif-drop";
import { blockCard } from "./card";

export type WhatIfBlockProps = Pick<WhatIfResponse, "asset" | "price" | "loans" | "hypothetical" | "cash"> & {
  /** The fall the user asked for (a slider step); 20 when none. */
  initialDrop?: number;
  /** The asked fall was above the slider's range. */
  capped?: boolean;
};

/** The slider only picks a step; each loan's health and status for every step came from the server. */
export function WhatIfBlock({ asset, price, loans, hypothetical, cash, initialDrop, capped }: WhatIfBlockProps) {
  const steps = (loans[0]?.steps ?? hypothetical?.steps ?? []).map((s) => s.drop);
  const [i, setI] = useState(Math.min(Math.max(steps.indexOf(initialDrop ?? DEFAULT_DROP), 0), Math.max(steps.length - 1, 0)));
  const pct = steps[i] ?? 0;
  const hyp = hypothetical?.steps[i];
  const slider = steps.length > 0;
  const afterPrice = Math.round(price * (1 - pct / 100));
  return (
    <div className={blockCard}>
      {slider && <label className="flex flex-col gap-2">
        <span className="font-medium">If {asset} falls {pct}%{loans.length === 0 && hypothetical && <span className="font-normal text-muted-foreground">, assuming a {usd(cash)} loan</span>}</span>
        <input type="range" min={0} max={Math.max(steps.length - 1, 0)} step={1} value={i} onChange={(e) => setI(+e.target.value)} className="w-full accent-foreground" aria-label={`${asset} price fall, percent`} aria-valuetext={`${pct}%`} />
      </label>}
      <p className="text-xs text-muted-foreground">{asset} is {usd(price)} now.{slider && <> After this fall: about {usd(afterPrice)}.</>}</p>
      {capped && <p className="text-xs text-muted-foreground">This tries falls up to {MAX_DROP}%.</p>}
      {loans.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {loans.map((l) => {
            const s = l.steps[i];
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span>{l.lender} <span className="text-muted-foreground">· {l.collAsset} · </span><NetworkChip id={l.chainId} className="border-0 px-0 py-0" /></span>
                {s && <StatusPill s={s.status} hf={s.hf} />}
              </li>
            );
          })}
        </ul>
      ) : hypothetical && hyp ? (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-x-1.5">A {usd(cash)} loan would be: <StatusPill s={hyp.status} /></p>
          <p className="text-xs text-muted-foreground">It is liquidated if {asset} falls below {usd(hypothetical.liqPrice)}.</p>
        </div>
      ) : cash < MIN_LOAN ? (
        <p className="text-muted-foreground">Add crypto to this Safe to see what a price fall would do to a loan.</p>
      ) : (
        <p className="text-muted-foreground">This Safe cannot safely back {usd(cash)} with {asset}.</p>
      )}
    </div>
  );
}
