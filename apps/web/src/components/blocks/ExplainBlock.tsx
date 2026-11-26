"use client";

import { usd } from "@/lib/format";
import { DEFAULT_LEVELS, MIN_LOAN, type Levels } from "@/lib/loan-math";
import type { UIBlock } from "@/lib/blocks";
import { Button } from "@/components/ui/button";
import { blockCard } from "./card";

type Topic = Extract<UIBlock, { kind: "explain" }>["topic"];

const copy = (topic: Topic, needs: number): string[] => ({
  how: ["You keep your crypto and lock some of it as collateral. A lender sends you dollars (USDC or DAI). You pay interest and can repay any time. If the crypto's price falls too far, the lender can sell part of it to repay itself; that is liquidation."],
  health: [`Health factor compares what your collateral is worth with what you owe. Above ${DEFAULT_LEVELS.warn} is comfortable, below ${DEFAULT_LEVELS.act} needs action, at 1.0 the loan can be liquidated.`],
  liquidation: ["Liquidation is when a lender sells collateral to repay your loan.", "It happens when the health factor reaches 1.0, which means the price of your collateral fell too far.", "Your current monitoring status appears on the loan page. Check Settings to see where email alerts go and whether delivery is available. Checks can be delayed or unavailable, so they may not warn you in time."],
  collateral: ["Collateral is the crypto you lock to back a loan. You still own it.", "You get it back when you repay the loan.", "The more you lock, the more the price can fall before liquidation."],
  safe: [`A Safe is a shared wallet. Transactions need ${needs} owner signatures. I can only suggest them.`],
  reserve: ["A reserve is a second Safe with spare funds. If a loan gets close to liquidation, I can add collateral or repay from it.", "It can only spend up to the daily limit you set."],
}[topic]);

/** Health factor scale 1.0 to 2.0 with the user's alert levels. */
function Scale({ warn, act }: { warn: number; act: number }) {
  const pos = (v: number) => `${(Math.min(Math.max(v, 1), 2) - 1) * 100}%`;
  return (
    <div className="mb-6 px-3" role="img" aria-label={`Health factor scale: liquidation at 1.0, needs action below ${act}, comfortable above ${warn}`}>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-destructive via-warning to-success">
        {([[1, "1.0"], [act, String(act)], [warn, String(warn)], [2, "2.0"]] as const).map(([v, l]) => (
          <span key={l} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: pos(v) }}>
            <span className="h-3 w-px bg-foreground" />
            <span className="mt-0.5 text-xs tabular-nums text-muted-foreground">{l}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * `needs` is the number of owner signatures the Safe requires; `levels` the alert levels of the loan the scale shows;
 * `maxCash` the most the Safe can safely borrow (a plan button shows when it reaches the smallest loan).
 */
export function ExplainBlock({ block, needs, levels = DEFAULT_LEVELS, maxCash = 0, onSend }: { block: Extract<UIBlock, { kind: "explain" }>; needs: number; levels?: Levels; maxCash?: number; onSend: (text: string) => void }) {
  const t = block.topic;
  const plan = Math.min(10000, maxCash);
  return (
    <div className={blockCard}>
      {copy(t, needs).map((s) => <p key={s}>{s}</p>)}
      {(t === "health" || t === "liquidation") && <Scale warn={levels.warn} act={levels.act} />}
      {t !== "safe" && t !== "reserve" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onSend("Show me with numbers")}>Show me with numbers</Button>
          {t === "how" && plan >= MIN_LOAN && <Button size="sm" variant="outline" onClick={() => onSend(`Borrow ${usd(plan)}`)}>Plan {usd(plan)}</Button>}
        </div>
      )}
    </div>
  );
}
