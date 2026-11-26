import { useEffect, useState } from "react";
import { ArrowRightLeft, Banknote, ChevronDown, ChevronRight, Landmark, Lock, Percent, Receipt, TrendingDown } from "lucide-react";
import { PRICES, VENUES, fmt, networkName, usd, type Asset, type Network } from "@/data";
import { altLine, cashChips, cashDoneLine, choosePlan, costLine, feesLine, holdingsOf, maxCashSafe, moveLine, moveReason, lenderLimit, plansAcross, resolveHolding, type CashPlan, type Holding } from "@/lib/cash-plan";
import { agentOn, balancesOn, lendersFor } from "@/lib/networks";
import { actionName, planSummary, scopeText } from "@/lib/loan-copy";
import { DEFAULT_LEVELS, MIN_LOAN, parseUsd } from "@/lib/loan-math";
import { useApp } from "@/store";
import { emptyDraft, receiptLine } from "@/lib/plan-draft";
import type { Spec } from "@/lib/proposals";
import { cn } from "@/lib/utils";
import { ActionFooter, SentLine, StepBar, useFocusOnChange, AddAgentButton, radioCard } from "@/components/common";
import { ProposalCard } from "@/components/ChatCards";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const LABELS = ["Amount", "Plan"];
const TIMES = [
  { months: 3 as const, title: "A few months", phrase: "for a few months" },
  { months: 12 as const, title: "About a year", phrase: "about a year" },
  { months: 24 as const, title: "Longer or not sure", phrase: "longer than a year" },
];
const SAFETY = [
  { title: "Extra safe", word: "extra safe", hf: 2.0, extra: "" },
  { title: "Balanced", word: "balanced safety", hf: DEFAULT_LEVELS.warn, extra: "" },
  { title: "Lean", word: "lean safety", hf: DEFAULT_LEVELS.act, extra: " I'll alert you often." },
];

/** Balance with at most two decimals: 8, 0.5, 6.12. */
const held = (n: number) => String(+n.toFixed(2));

/** "10k", "$10,000" or a bare "500"; null when it is not a positive amount. */
const parseCash = (text: string) => {
  const n = parseUsd(text) ?? Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function GetCash() {
  const { view, safe, loans, proposals, go, sendLoan, planDraft, patchPlanDraft } = useApp();
  const preset: { amount?: number; step?: number } = view.name === "cash" ? view : {};
  const [step, setStep] = useState(preset.step === 2 ? 1 : 0);
  const d = planDraft[safe.id] ?? emptyDraft;
  const set = (partial: Parameters<typeof patchPlanDraft>[1]) => patchPlanDraft(safe.id, partial);
  const amountText = d.text;
  const months = d.months;
  const hfIdx = d.hfIdx;
  /** What the user chose in Change asset; anything missing is filled in from what the Safe holds. */
  const pick: Partial<Holding> = { asset: d.asset, network: d.network };
  const venueId = d.venueId ?? null;
  const lock = d.collateral ?? null;
  const sentId = d.sentId ?? null;
  const [adjust, setAdjust] = useState(false);
  /** The success heading, fixed at Send: after execution the loan list already holds the new loan. */
  const [sentPast, setSentPast] = useState("");

  // The agent or an offer can reopen the flow with an amount while it is already on screen: that starts a new plan.
  useEffect(() => {
    if (view.name !== "cash") return;
    setStep(view.step === 2 ? 1 : 0);
    setAdjust(false);
    if (view.amount) patchPlanDraft(safe.id, { text: usd(view.amount), hfIdx: 1, asset: view.asset, network: view.network, venueId: view.venueId, collateral: view.collateral, sentId: undefined });
  }, [view]);

  const owned = holdingsOf(safe.balances);
  const maxBalanced = maxCashSafe(safe, PRICES, DEFAULT_LEVELS.warn);
  const card = (children: React.ReactNode, fill = false) => (
    <div className={cn("flex min-h-full justify-center p-4 pt-[6vh]", fill ? "items-stretch" : "items-start")}>
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">{children}</div>
    </div>
  );

  const first = sentId ? proposals[sentId] : null;
  /** After a move executes, the card follows the loan the agent drafted next. */
  const sent = (first?.spec.kind === "move" && Object.values(proposals).find((p) => p.spec === (first.spec as Extract<Spec, { kind: "move" }>).then)) || first;
  // Screen 0 attaches no ref: the amount input keeps its autoFocus.
  const finished = sent?.stage === 3 && sent.spec.kind !== "move";
  const focusRef = useFocusOnChange<HTMLDivElement & HTMLHeadingElement>(`${step}-${sentId}-${sent?.id}-${finished}`);

  if (maxBalanced < MIN_LOAN && !sent) {
    return card(
      <>
        <h1 className="text-lg font-medium">{owned.length === 0 ? "Add ETH, wstETH or WBTC to this Safe first." : `This Safe doesn't hold enough to borrow ${usd(MIN_LOAN)} safely.`}</h1>
        <p className="text-xs text-muted-foreground">You borrow against ETH, wstETH or WBTC. Once it holds some, I can plan a loan.</p>
        <Button size="lg" onClick={() => go({ name: "home" })}>Go to Overview</Button>
      </>,
    );
  }

  const cash = parseCash(amountText);
  /** A new amount clears Adjust choices that may no longer fit it. */
  const editAmount = (text: string) => {
    if (parseCash(text) === cash) return set({ text });
    set({ text, asset: undefined, network: undefined, hfIdx: 1, collateral: undefined, venueId: undefined });
  };
  const tooSmall = cash === null || cash < MIN_LOAN;
  const tooBig = cash !== null && cash > maxBalanced;
  const screen = sent || (step === 1 && !tooSmall && !tooBig) ? 1 : 0;
  const targetHf = SAFETY[hfIdx].hf;
  const { asset: useAsset, network } = resolveHolding(safe, PRICES, cash ?? MIN_LOAN, DEFAULT_LEVELS.warn, pick);
  const balances = balancesOn(safe, network);
  const netName = networkName(network);
  const price = PRICES[useAsset];
  const plansFor = (n: ReturnType<typeof need>) => plansAcross(safe, n, PRICES, VENUES, loans);
  const need = (hf: number) => ({ cash: cash ?? 0, months, targetHf: hf, asset: useAsset, network });
  const locked = { ...need(targetHf), collateral: lock ?? undefined };
  const all = plansFor(locked);
  const choice = choosePlan(all);
  const best = choice?.plan ?? null;
  const unreachable = VENUES.filter((v) => !lendersFor(safe, network).includes(v));
  const plan: CashPlan | null = all.find((p) => p.venue.id === venueId && p.feasible) ?? best;
  /** The first network the agent still has to be added on: the loan's, and the move's source. */
  const missing = plan && [plan.move?.from, plan.network].find((n) => n && !agentOn(safe, n));
  const canSend = !missing;
  const alt = choice?.alternative && plan === best ? choice.alternative : undefined;
  const fromOffers = view.name === "cash" && view.from === "offers";

  const choices = SAFETY.map((s) => {
    const ps = plansFor(need(s.hf));
    const ok = choosePlan(ps)?.plan ?? null;
    return { ...s, ok, fewest: Math.min(...ps.map((p) => p.collateral)) };
  });

  return card(
    <>
      {!finished && <StepBar labels={LABELS} step={screen} />}

      {screen === 0 && (
        <>
          <h1 className="text-lg font-medium">How much cash do you need?</h1>
          <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); if (!tooSmall && !tooBig) setStep(1); }}>
            <Field
              label="Cash you need" labelHidden messageClassName="min-h-8"
              tone={amountText.trim() && cash === null ? "error" : tooBig ? "error" : cash !== null && tooSmall ? "error" : "hint"}
              message={
                amountText.trim() && cash === null ? "Use numbers only, for example $5,000."
                : tooBig ? `The most this Safe can safely borrow against is ${usd(maxBalanced)}.`
                : cash !== null && tooSmall ? `The smallest loan is ${usd(MIN_LOAN)}.`
                : `With what's in this Safe you can borrow ${usd(MIN_LOAN)} to ${usd(maxBalanced)}.`
              }
            >
              {(p) => (
                <Input
                  {...p} inputMode="decimal" placeholder="e.g. $10,000" autoFocus
                  className="h-12 text-xl font-medium md:text-xl"
                  value={amountText}
                  onChange={(e) => editAmount(e.target.value)}
                  onBlur={() => cash && set({ text: usd(cash) })}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              {cashChips(maxBalanced).map((c) => <Button key={c.label} type="button" variant="outline" size="sm" onClick={() => editAmount(usd(c.amount))}>{c.label}</Button>)}
            </div>
            <Button size="lg" type="submit" disabled={tooSmall || tooBig}>Next</Button>
          </form>
        </>
      )}

      {finished && sent && (
        <div className="flex flex-col gap-3 text-sm" role="status">
          <h1 ref={focusRef} tabIndex={-1} className="text-lg font-medium outline-none">{sentPast}</h1>
          {sent.spec.kind === "open" && <p>{cashDoneLine(sent.spec.borrow, VENUES.find((v) => v.id === (sent.spec as { venueId: string }).venueId)?.borrowAsset ?? "", safe.name)}</p>}
          <Button size="lg" onClick={() => go({ name: "loan", id: sent.loanId })}>View loan</Button>
          <Button variant="ghost" onClick={() => { set(null); setStep(0); setAdjust(false); }}>Get more cash</Button>
        </div>
      )}

      {screen === 1 && !finished && sent && first && (first.spec.kind === "open" || first.spec.kind === "move") && (
        <div ref={focusRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
          <SentLine>{receiptLine(first.spec, VENUES.find((v) => v.id === (first.spec.kind === "move" ? first.spec.then : (first.spec as { venueId: string })).venueId)?.name ?? "")}</SentLine>
          {sent.stage >= 0 && sent.stage < 3 && <h1 className="text-lg font-medium">Next: sign in your Safe</h1>}
          {sent.stage === 3 && sent.spec.kind === "move" && <p className="text-sm text-muted-foreground">Your {sent.spec.move.asset} arrived. I am drafting the loan.</p>}
          {sent.stage < 0 && <Button variant="outline" onClick={() => set({ sentId: undefined })}>Start again</Button>}
          <ProposalCard id={sent.id} />
        </div>
      )}

      {screen === 1 && !finished && !sent && cash !== null && (() => {
        const added = plan?.scope === "added";
        const summary = plan ? planSummary({ cash, venue: plan.venue.name, apr: plan.apr, collateral: plan.collateral, asset: useAsset, liqPrice: plan.liqPrice, adding: added }) : ["", ""];
        const pickedVenue = venueId !== null && plan && plan.venue.id !== venueId ? VENUES.find((v) => v.id === venueId) : undefined;
        const backToOffers = () => go(plan ? { name: "offers", asset: useAsset, network, amount: plan.collateral, borrow: cash } : { name: "offers", asset: view.name === "cash" ? view.asset : undefined, network: view.name === "cash" ? view.network : undefined, amount: view.name === "cash" ? view.collateral : undefined, borrow: view.name === "cash" ? view.amount : undefined });
        const timeWord = TIMES.find((t) => t.months === months)!.phrase;
        return (
          <>
            <h1 ref={focusRef} tabIndex={-1} className="text-lg font-medium outline-none">Your plan</h1>
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span>{lock !== null && plan ? `Using ${fmt(plan.collateral, 2)} ${useAsset} as you picked in offers, ${timeWord}.` : `Using ${useAsset}, ${SAFETY[hfIdx].word}, ${timeWord}.`}</span>
            </div>
            {pickedVenue && plan && <p className="text-sm text-muted-foreground">{pickedVenue.name} can't lend this much against your {useAsset}, so I picked {plan.venue.name}.</p>}

            {plan ? (
            <ul className="flex flex-col gap-3 text-sm">
              {added && <Row icon={Banknote}>{actionName(plan, cash).title}. You'll owe {usd(plan.debt)} in total.</Row>}
              <Row icon={Banknote}>You get {usd(cash)} as {plan.venue.borrowAsset}, a digital dollar, in {safe.name}.</Row>
              <Row icon={TrendingDown}>{added ? `On the full ${usd(plan.debt)} loan you're safe` : "You're safe"} unless {useAsset} falls below {usd(plan.liqPrice)}, {plan.dropPct}% under today's {usd(price)}. I watch it all day and tell you well before.</Row>
              <Row icon={Lock}>
                {added
                  ? <>You lock {fmt(plan.collateral, 2)} {useAsset} more ({usd(plan.collateral * price)}), {fmt(plan.totalCollateral, 2)} {useAsset} in total. {fmt(balances[useAsset] - plan.collateral, 2)} {useAsset} stays free.</>
                  : <>You lock {fmt(plan.collateral, 2)} {useAsset} ({usd(plan.collateral * price)}). {fmt(balances[useAsset] - plan.collateral, 2)} {useAsset} stays free.</>}
              </Row>
              <Row icon={Percent}>{costLine(plan, months)}</Row>
              <Row icon={Receipt}>{feesLine(plan, PRICES.ETH)}</Row>
              <Row icon={Landmark}>On {networkName(plan.network)}, with {plan.venue.name}, {plan.venue.id === best?.venue.id ? "the lowest rate that fits" : "the one you picked"}.</Row>
              {plan.move && <Row icon={ArrowRightLeft}>{moveLine(plan.move)} <span className="text-muted-foreground">{moveReason(plan, all)}</span></Row>}
            </ul>

            ) : (
              <p className="text-sm">Your {useAsset} can't safely back {usd(cash)} right now. Pick another asset under "Change asset, safety or time", or go back and lower the amount.</p>
            )}
            {alt && <p className="text-sm text-muted-foreground">{altLine(alt.plan, alt.saves)} <Button variant="link" size="inline" onClick={() => set({ venueId: alt.plan.venue.id })}>Use {alt.plan.venue.name}</Button></p>}
            <Button variant="outline" size="sm" className="self-start" aria-expanded={adjust} onClick={() => setAdjust((a) => !a)}>Change asset, safety or time</Button>
            {adjust && (
              <div className="flex flex-col gap-3 rounded-xl bg-muted/40 p-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Use:
                  <NativeSelect value={`${network}:${useAsset}`} onChange={(e) => { const [n, a] = e.target.value.split(":"); set({ network: n as Holding["network"], asset: a as Asset, collateral: undefined }); }}>
                    {owned.map((h) => {
                      const have = balancesOn(safe, h.network)[h.asset];
                      const ok = choosePlan(plansFor({ ...need(targetHf), ...h }));
                      const where = owned.some((o) => o.asset === h.asset && o.network !== h.network) ? ` · ${networkName(h.network)}` : "";
                      return <NativeSelectOption key={`${h.network}:${h.asset}`} value={`${h.network}:${h.asset}`} disabled={!ok}>{h.asset}{where} · {held(have)} in Safe{ok ? "" : ` · not enough for ${usd(cash)}`}</NativeSelectOption>;
                    })}
                  </NativeSelect>
                </label>
                <span className="text-xs text-muted-foreground">How careful should we be?</span>
                <div role="radiogroup" aria-label="How careful" className="flex flex-col gap-2">
                  {choices.map((c, i) => (
                    <label key={c.title} className={radioCard(hfIdx === i, !c.ok)}>
                      <input type="radio" className="sr-only" name="careful" checked={hfIdx === i} disabled={!c.ok} onChange={() => set({ hfIdx: i as 0 | 1 | 2, collateral: undefined })} />
                      <span className="text-sm font-medium">{c.title}</span>
                      {c.ok ? (
                        <>
                          <span className="text-xs">Locks {fmt(c.ok.collateral, 2)} {useAsset} of your {held(balances[useAsset])}.</span>
                          <span className="text-xs text-muted-foreground">{useAsset} can fall about {c.ok.dropPct}%{scopeText(c.ok)} before trouble.{c.extra}</span>
                        </>
                      ) : (
                        <span className="text-xs">Needs {fmt(c.fewest, 2)} {useAsset}, you have {held(balances[useAsset])}.</span>
                      )}
                    </label>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">How long will you keep it?</span>
                <div role="radiogroup" aria-label="How long" className="flex flex-col gap-2">
                  {TIMES.map((t) => (
                    <label key={t.months} className={radioCard(months === t.months)}>
                      <input type="radio" className="sr-only" name="time" checked={months === t.months} onChange={() => set({ months: t.months as 3 | 12 | 24 })} />
                      <span className="text-sm font-medium">{t.title}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">There is no fixed schedule. You can repay any time. Trouble means the lender can sell some of your {useAsset} to repay the loan. I watch the price and warn you well before.</p>
              </div>
            )}

            {plan && (
              <details className="group rounded-xl ring-1 ring-foreground/10">
                <summary className="flex cursor-pointer list-none items-center justify-between p-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  Other lenders <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="flex flex-col gap-1 px-3 pb-3">
                  {all.filter((p) => p.venue.id !== plan.venue.id).map((p) => p.feasible ? (
                    <button key={p.venue.id} onClick={() => set({ venueId: p.venue.id })} className="flex items-center justify-between gap-2 rounded-lg p-2 text-left text-sm hover:bg-muted/50 pointer-coarse:min-h-11">
                      <span>{p.venue.name} · {p.apr}% · about {usd(p.newYearly)} a year{p.scope === "added" && " · adds to your loan"}{p.move && ` · needs a move from ${networkName(p.move.from)} (about ${usd(p.move.feeUsd)})`}</span>
                      <span className="flex shrink-0 items-center text-muted-foreground">Use <ChevronRight className="size-4" /></span>
                    </button>
                  ) : (
                    <span key={p.venue.id} className="p-2 text-sm text-muted-foreground">{(() => { const limit = lenderLimit(p.venue, useAsset, balances[useAsset], price, targetHf); return limit === null ? `${p.venue.name} · not available against ${useAsset}` : `${p.venue.name} · can lend up to ${usd(limit)} against your ${useAsset}`; })()}</span>
                  ))}
                  {unreachable.map((v) => <span key={v.id} className="p-2 text-sm text-muted-foreground">{v.name} · not on any of this Safe's networks</span>)}
                  <Button variant="link" className="self-start px-2" onClick={backToOffers}>Compare all offers</Button>
                </div>
              </details>
            )}

              <ActionFooter
                className="-mx-5 px-5"
                label={<>
                  {adjust && <p className="text-xs text-muted-foreground">{summary[0]}<br />{summary[1]}</p>}
                  {missing && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">The agent isn't on {networkName(missing)} for this Safe yet. <AddAgentButton size="sm" /></div>}
                </>}
              >
                <Button size="lg" variant="ghost" onClick={() => (fromOffers ? backToOffers() : setStep(0))}>
                  {fromOffers ? "Back to offers" : "Back"}
                </Button>
                {plan && <Button size="lg" disabled={!canSend} onClick={() => { setSentPast(actionName(plan, cash).past); sendLoan(plan.venue.id, useAsset, plan.collateral, cash, plan.network, plan.move); }}>{plan.move ? "Send move to Safe (step 1 of 2)" : "Send to Safe for signatures"}</Button>}
              </ActionFooter>
          </>
        );
      })()}
    </>,
    screen === 1,
  );
}

const Row = ({ icon: Icon, children }: { icon: typeof Banknote; children: React.ReactNode }) => (
  <li className="flex items-start gap-3">
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"><Icon className="size-4" /></span>
    <span className="min-w-0 pt-1">{children}</span>
  </li>
);
