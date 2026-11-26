import { PRICES, usd } from "@/data";
import { maxCashSafe } from "@/lib/cash-plan";
import { DEFAULT_LEVELS, MIN_LOAN, levelsOf } from "@/lib/loan-math";
import { requiredSignatures } from "@/lib/loan-copy";
import type { UIBlock } from "@/lib/blocks";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { blockCard } from "./card";

type Topic = Extract<UIBlock, { kind: "explain" }>["topic"];

const copy = (topic: Topic, needs: number): string[] => ({
  how: ["You keep your crypto and lock some of it as collateral. A lender sends you dollars (USDC or DAI). You pay interest and can repay any time. If the crypto's price falls too far, the lender can sell part of it to repay itself; that is liquidation."],
  health: ["Health factor compares what your collateral is worth with what you owe. Above 1.6 is comfortable, below 1.35 needs action, at 1.0 the loan can be liquidated."],
  liquidation: ["Liquidation is when a lender sells part of your collateral to repay your loan.", "It happens when the health factor reaches 1.0, which means the price of your collateral fell too far.", "I alert you well before that, so you can add collateral or repay."],
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

export function ExplainBlock({ block }: { block: Extract<UIBlock, { kind: "explain" }> }) {
  const { safe, loans, thresholds, postBlock } = useApp();
  const lv = loans[0] ? levelsOf(thresholds, loans[0].id) : DEFAULT_LEVELS;
  const t = block.topic;
  const plan = Math.min(10000, maxCashSafe(safe, PRICES, DEFAULT_LEVELS.warn));
  return (
    <div className={blockCard}>
      {copy(t, requiredSignatures(safe.threshold)).map((s) => <p key={s}>{s}</p>)}
      {(t === "health" || t === "liquidation") && <Scale warn={lv.warn} act={lv.act} />}
      {t !== "safe" && t !== "reserve" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => postBlock({ kind: "whatif" })}>Show me with numbers</Button>
          {t === "how" && plan >= MIN_LOAN && <Button size="sm" variant="outline" onClick={() => postBlock({ kind: "plan", cash: plan })}>Plan {usd(plan)}</Button>}
        </div>
      )}
    </div>
  );
}
