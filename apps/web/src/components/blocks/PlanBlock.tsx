"use client";

import { useId, type ReactNode } from "react";
import { fmt, usd } from "@/lib/format";
import { cashChips } from "@/lib/cash-plan";
import { BALANCED_HF, LEAN_HF, MIN_LOAN, parseUsd } from "@/lib/loan-math";
import { wasNowLine, type PreviousPlan } from "@/lib/borrow-limit";
import { planSummary } from "@/lib/loan-copy";
import type { UIBlock } from "@/lib/blocks";
import { cappedNote } from "@/lib/plan-draft";
import { SentLine } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { blockCard } from "./card";

export const SAFETY = [
  { title: "Extra safe", hf: 2.0 },
  { title: "Balanced", hf: BALANCED_HF },
  { title: "Lean", hf: LEAN_HF },
];

/** One plain sentence per `SAFETY` option (same order), no figures. */
const SAFETY_HINT = [
  (asset: string) => `Extra safe: you lock more ${asset}, so its price can fall further before the lender can sell it to repay the loan.`,
  (asset: string) => `Balanced: the middle choice between how much ${asset} you lock and how far its price can fall.`,
  (asset: string) => `Lean: you lock less ${asset}, so a smaller price fall lets the lender sell it to repay the loan.`,
];

/** The figures the server computed for one plan. The block prints them and computes none of its own (no figure comes from the model). */
export type PlanQuote =
  | {
      kind: "ok";
      /** Dollars the user gets, paid in `borrowAsset`. */
      cash: number;
      borrowAsset: string;
      /** The collateral locked, its value, and the price now. */
      asset: string;
      collateral: number;
      collateralUsd: number;
      price: number;
      /** The collateral price below which the loan is liquidated, and the percent fall to get there. */
      liqPrice: number;
      dropPct: number;
      /** True when the plan adds to a loan the Safe already has. */
      adding: boolean;
      apr: number;
      /** Interest a year. */
      yearly: number;
      /** "One-time network fee: about $4 to set up the loan." (from `feesLine`). */
      feesLine: string;
      lender: string;
      /** Display name of the network the loan is on. */
      network: string;
      /** Set when the collateral moves first: the line, and why. */
      move?: { line: string; reason?: string | null };
      /** A cheaper plan on another network. `line` is the `altLine` sentence. */
      alt?: { line: string; venueId: string; venueName: string };
    }
  | {
      /** The Safe cannot safely back this amount. `reason` replaces the default sentence. */
      kind: "notFeasible";
      asset: string;
      cash: number;
      reason?: string;
    }
  | {
      /** No lender can serve this Safe yet. */
      kind: "unavailable";
    };

export type PlanBlockProps = {
  block: Extract<UIBlock, { kind: "plan" }>;
  /** False for an earlier plan message: it shows one muted line. */
  live?: boolean;
  /** Receipt line once the plan was sent to the Safe. It replaces the form. */
  sent?: string;
  /** The most the Safe can safely borrow (dollars), and the display name of the network when one was asked for. */
  maxCash: number;
  networkName?: string;
  /** The amount field text, and the safety choice (index into SAFETY). The parent owns both and refetches the quote. */
  cashText: string;
  safetyIdx: 0 | 1 | 2;
  onCashText: (text: string) => void;
  onSafety: (idx: 0 | 1 | 2) => void;
  /** Quote for the current inputs. `null` with no `loading` and no `error` means the inputs are not valid yet. */
  quote?: PlanQuote | null;
  loading?: boolean;
  error?: string;
  /** Set when the agent is not yet a proposer on this network: the send button is replaced by this prompt and `addAgentSlot` (a button). */
  addAgentNetwork?: string;
  addAgentSlot?: ReactNode;
  /** The plan before the user switched lender: shows one Was/now note (VC-02). */
  previous?: PreviousPlan;
  /** Offered next to an error that a retry can clear. */
  onRetry?: () => void;
  onSend: () => void;
  onUseAlt?: (venueId: string) => void;
  onOpenPlanner?: () => void;
  /** A what-size card (`block.hypothetical`) offers this chip: plan a loan the Safe can afford. */
  onAffordable?: () => void;
  /** Disables the send button (a send is in flight). */
  sending?: boolean;
  /** A send is in flight: the button says so. */
  sendingNow?: boolean;
  /** Lines shown between the figures and the send button (test run, send status). */
  footer?: ReactNode;
};

/** Fee lines come from the server; a zero fee is never printed as "about $0.00". */
export const tidyFee = (line: string) => line.replace(/(?:about )?\$0\.00\b/g, "less than $0.01");

const parseCash = (text: string) => {
  const n = parseUsd(text) ?? Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function PlanBlock({ block, live = true, sent, maxCash, networkName, cashText, safetyIdx, onCashText, onSafety, quote, loading, error, addAgentNetwork, addAgentSlot, previous, onRetry, onSend, onUseAlt, onOpenPlanner, onAffordable, sending, sendingNow, footer }: PlanBlockProps) {
  const hintId = useId();
  if (!live) return <div className={blockCard}><p className="text-muted-foreground">Earlier plan for {usd(block.cash)}</p></div>;
  if (sent) return <div className={blockCard}><SentLine>{sent}</SentLine></div>;
  if (block.refusal) return <div className={blockCard}><p>This Safe doesn't hold enough ETH or wstETH{networkName && ` on ${networkName}`} to borrow {usd(Math.max(block.cash, MIN_LOAN))} safely.{block.refusal.needUsd > 0 && ` You'd need about ${usd(block.refusal.needUsd)} more.`}</p></div>;
  if (maxCash < MIN_LOAN) return <div className={blockCard}><p>This Safe doesn't hold enough ETH or wstETH{networkName && ` on ${networkName}`} to borrow {usd(MIN_LOAN)} safely.</p></div>;

  const cash = parseCash(cashText);
  const bad = cash === null ? "Use numbers only, for example $5,000." : cash < MIN_LOAN ? `The smallest loan is ${usd(MIN_LOAN)}.` : cash > maxCash ? `The most this Safe can safely borrow against is ${usd(maxCash)}.` : "";
  const capped = cappedNote(block.cash, maxCash, cash);

  const hypothetical = !!block.hypothetical;
  return (
    <div className={blockCard}>
      {hypothetical ? (
        <p className="text-lg font-medium">{usd(block.cash)} <span className="text-xs font-normal text-muted-foreground">at Balanced safety</span></p>
      ) : (
      <div className="flex flex-col gap-2">
        <Input inputMode="decimal" aria-label="Cash you need" aria-invalid={!!bad} value={cashText} onChange={(e) => onCashText(e.target.value)} onBlur={() => cash && onCashText(usd(cash))} className="h-10 text-lg font-medium md:text-lg" />
        <div className="flex flex-wrap gap-2">
          {cashChips(maxCash).map((c) => <Button key={c.label} type="button" variant="outline" size="sm" className="min-h-11" onClick={() => onCashText(usd(c.amount))}>{c.label}</Button>)}
        </div>
        {bad ? <p className="text-xs text-destructive-text">{bad}</p> : capped && <p className="text-xs text-muted-foreground">{capped}</p>}
      </div>
      )}

      {!hypothetical && <fieldset className="flex flex-wrap gap-2" aria-describedby={hintId}>
        <legend className="sr-only">How careful</legend>
        {SAFETY.map((s, i) => (
          <label key={s.title} className={cn("flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-lg px-2 py-1.5 text-center text-xs ring-1 ring-foreground/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring", safetyIdx === i ? "bg-muted ring-2 ring-foreground" : "hover:bg-muted/50")}>
            <input type="radio" className="sr-only" name={`safety-${block.cash}-${block.asset ?? ""}-${block.network ?? ""}`} checked={safetyIdx === i} onChange={() => onSafety(i as 0 | 1 | 2)} />
            {s.title}
          </label>
        ))}
        <p id={hintId} className="basis-full text-xs text-muted-foreground">{SAFETY_HINT[safetyIdx](quote?.kind === "ok" || quote?.kind === "notFeasible" ? quote.asset : block.asset ?? "ETH")}</p>
      </fieldset>}

      {bad && !hypothetical ? null : error ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive-text">{error}{onRetry && <Button type="button" size="sm" variant="outline" onClick={onRetry}>Try again</Button>}</p>
      ) : loading ? (
        <p className="flex items-center gap-2 text-muted-foreground"><Spinner /> Working out the plan</p>
      ) : !quote ? null : quote.kind === "unavailable" ? (
        <p>Loans are not available for this Safe yet.</p>
      ) : quote.kind === "notFeasible" ? (
        <p>{quote.reason ?? `Your ${quote.asset} can't safely back ${usd(quote.cash)} right now. Try a smaller amount or another safety level.`}</p>
      ) : (
        <>
          {previous && <p className="rounded-md border border-border px-3 py-2 text-xs">{wasNowLine(previous, { lender: quote.lender, apr: quote.apr, yearly: quote.yearly })}</p>}
          <ul className="flex flex-col gap-1.5">
            <li className="font-medium">You get {usd(quote.cash)} as {quote.borrowAsset}, a digital dollar.</li>
            <li>You lock {fmt(quote.collateral, 2)} {quote.asset} ({usd(quote.collateralUsd)}).</li>
            <li>{planSummary({ cash: quote.cash, venue: quote.lender, apr: quote.apr, collateral: quote.collateral, asset: quote.asset, price: quote.price, liqPrice: quote.liqPrice, dropPct: quote.dropPct, adding: quote.adding })[1]}</li>
            {!quote.adding && <li>{quote.yearly < 1 ? "Less than $1" : `About ${usd(quote.yearly)}`} a year at {quote.apr}%. The rate can change.</li>}
            <li>{tidyFee(quote.feesLine)}</li>
            <li>On {quote.network}, with {quote.lender}.</li>
            {quote.move && <li>{quote.move.line} {quote.move.reason && <span className="text-muted-foreground">{quote.move.reason}</span>}</li>}
            {quote.alt && <li className="text-muted-foreground">{quote.alt.line} <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onUseAlt?.(quote.alt!.venueId)}>Use {quote.alt.venueName}</button></li>}
          </ul>
          {footer && <div className="flex flex-col gap-1">{footer}</div>}
          {hypothetical ? (
            <>
              <p className="text-xs text-muted-foreground">This shows what that amount would need. Nothing is sent.</p>
              {onAffordable && <Button type="button" variant="outline" size="sm" className="min-h-11 self-start" onClick={onAffordable}>Plan a loan I can afford</Button>}
            </>
          ) : addAgentNetwork ? (
            <div className="flex flex-col gap-2"><p className="text-xs text-muted-foreground">Add the agent to this Safe on {addAgentNetwork} so I can send proposals.</p>{addAgentSlot}</div>
          ) : (
            <>
              <Button disabled={sending} onClick={onSend}>{sendingNow ? "Sending to your Safe…" : quote.move ? "Approve move in your wallet (step 1 of 2)" : "Approve in your wallet"}</Button>
              <p className="-mt-1 text-xs text-muted-foreground">Sends this plan to your Safe, then your wallet asks for your free approval.</p>
            </>
          )}
          {onOpenPlanner && <button type="button" className="self-start text-xs underline underline-offset-2 hover:text-foreground text-muted-foreground" onClick={onOpenPlanner}>Open full planner</button>}
        </>
      )}
    </div>
  );
}
