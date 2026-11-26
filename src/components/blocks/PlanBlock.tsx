import { PRICES, VENUES, fmt, networkName, usd } from "@/data";
import { altLine, cashChips, choosePlan, feesLine, maxCashSafe, moveLine, moveReason, plansAcross, resolveHolding } from "@/lib/cash-plan";
import { agentOn } from "@/lib/networks";
import { DEFAULT_LEVELS, MIN_LOAN, parseUsd } from "@/lib/loan-math";
import { planSummary } from "@/lib/loan-copy";
import type { UIBlock } from "@/lib/blocks";
import { useApp } from "@/store";
import { cappedNote, isLivePlan, receiptLine, emptyDraft } from "@/lib/plan-draft";
import { AddAgentButton, SentLine } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { blockCard } from "./card";

const SAFETY = [
  { title: "Extra safe", hf: 2.0 },
  { title: "Balanced", hf: DEFAULT_LEVELS.warn },
  { title: "Lean", hf: DEFAULT_LEVELS.act },
];

const parseCash = (text: string) => {
  const n = parseUsd(text) ?? Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function PlanBlock({ block, msgId }: { block: Extract<UIBlock, { kind: "plan" }>; msgId?: string }) {
  const { loans, safe, sendLoan, proposals, planDraft, patchPlanDraft, go } = useApp();
  const stored = planDraft[safe.id];
  const d = stored ?? emptyDraft;
  const set = (partial: Parameters<typeof patchPlanDraft>[1]) => patchPlanDraft(safe.id, partial);
  const text = d.text;
  const hfIdx = d.hfIdx;
  const pickId = d.venueId;
  const sentProposal = d.sentId ? proposals[d.sentId] : undefined;
  if (!msgId || !isLivePlan(stored, msgId)) return <div className={blockCard}><p className="text-muted-foreground">Earlier plan for {usd(block.cash)}</p></div>;
  if (sentProposal && (sentProposal.spec.kind === "open" || sentProposal.spec.kind === "move")) {
    const spec = sentProposal.spec;
    const open = spec.kind === "move" ? spec.then : spec;
    return <div className={blockCard}><SentLine>{receiptLine(spec, VENUES.find((v) => v.id === open.venueId)?.name ?? "")}</SentLine></div>;
  }
  const max = maxCashSafe(safe, PRICES, DEFAULT_LEVELS.warn, d.network);
  const cash = parseCash(text);
  const { asset, network } = resolveHolding(safe, PRICES, cash ?? MIN_LOAN, DEFAULT_LEVELS.warn, { asset: d.asset, network: d.network });
  const bad = cash === null ? "Use numbers only, for example $5,000." : cash < MIN_LOAN ? `The smallest loan is ${usd(MIN_LOAN)}.` : cash > max ? `The most this Safe can safely borrow against is ${usd(max)}.` : "";
  const need = { cash: cash ?? 0, months: d.months, targetHf: SAFETY[hfIdx].hf, asset, network };
  const plans = bad ? [] : plansAcross(safe, need, PRICES, VENUES, loans);
  const choice = choosePlan(plans);
  const plan = plans.find((p) => p.venue.id === pickId && p.feasible) ?? choice?.plan ?? null;
  const alt = choice?.alternative && plan === choice.plan ? choice.alternative : undefined;
  /** The first network the agent still has to be added on: the loan's, and the move's source. */
  const missing = plan && [plan.move?.from, plan.network].find((n) => n && !agentOn(safe, n));
  const price = PRICES[asset];

  if (max < MIN_LOAN) return <div className={blockCard}><p>This Safe doesn't hold enough ETH, wstETH or WBTC{d.network && ` on ${networkName(d.network)}`} to borrow {usd(MIN_LOAN)} safely.</p></div>;

  return (
    <div className={blockCard}>
      <div className="flex flex-col gap-2">
        <Input inputMode="decimal" aria-label="Cash you need" aria-invalid={!!bad} value={text} onChange={(e) => set({ text: e.target.value })} onBlur={() => cash && set({ text: usd(cash) })} className="h-10 text-lg font-medium md:text-lg" />
        <div className="flex flex-wrap gap-2">
          {cashChips(max).map((c) => <Button key={c.label} type="button" variant="outline" size="sm" onClick={() => set({ text: usd(c.amount) })}>{c.label}</Button>)}
        </div>
        {bad ? <p className="text-xs text-destructive-text">{bad}</p> : cappedNote(block.cash, max, cash) && <p className="text-xs text-muted-foreground">{cappedNote(block.cash, max, cash)}</p>}
      </div>

      <fieldset className="flex flex-wrap gap-2" >
        <legend className="sr-only">How careful</legend>
        {SAFETY.map((s, i) => (
          <label key={s.title} className={cn("flex-1 cursor-pointer rounded-lg px-2 py-1.5 text-center text-xs ring-1 ring-foreground/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring", hfIdx === i ? "bg-muted ring-2 ring-foreground" : "hover:bg-muted/50")}>
            <input type="radio" className="sr-only" name={`safety-${safe.id}-${block.cash}-${asset}-${network}`} checked={hfIdx === i} onChange={() => set({ hfIdx: i as 0 | 1 | 2 })} />
            {s.title}
          </label>
        ))}
      </fieldset>

      {plan && cash !== null ? (
        <>
          <ul className="flex flex-col gap-1.5">
            <li className="font-medium">You get {usd(cash)} as {plan.venue.borrowAsset}, a digital dollar.</li>
            <li>You lock {fmt(plan.collateral, 2)} {asset} ({usd(plan.collateral * price)}).</li>
            <li>{planSummary({ cash, venue: plan.venue.name, apr: plan.apr, collateral: plan.collateral, asset, liqPrice: plan.liqPrice, adding: plan.scope === "added" })[1]} ({plan.dropPct}% under today's {usd(price)}).</li>
            <li>About {usd(plan.yearly)} a year at {plan.apr}%. The rate can change.</li>
            <li>{feesLine(plan, PRICES.ETH)}</li>
            <li>On {networkName(plan.network)}, with {plan.venue.name}.</li>
            {plan.move && <li>{moveLine(plan.move)} <span className="text-muted-foreground">{moveReason(plan, plans)}</span></li>}
            {alt && <li className="text-muted-foreground">{altLine(alt.plan, alt.saves)} <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => set({ venueId: alt.plan.venue.id })}>Use {alt.plan.venue.name}</button></li>}
          </ul>
          {missing ? (
            <div className="flex flex-col gap-2"><p className="text-xs text-muted-foreground">Add the agent to this Safe on {networkName(missing)} so I can send proposals.</p><AddAgentButton className="self-start" /></div>
          ) : (
            <Button onClick={() => sendLoan(plan.venue.id, asset, plan.collateral, cash, plan.network, plan.move)}>{plan.move ? "Send move to Safe (step 1 of 2)" : "Send to Safe for signatures"}</Button>
          )}
          <button type="button" className="self-start text-xs underline underline-offset-2 hover:text-foreground text-muted-foreground" onClick={() => go({ name: "cash", step: 2 })}>Open full planner</button>
        </>
      ) : !bad && <p>Your {asset} can't safely back {usd(cash ?? 0)} right now. Try a smaller amount or another safety level.</p>}
    </div>
  );
}
