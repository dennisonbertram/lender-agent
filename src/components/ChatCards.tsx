import { useState } from "react";
import { Check, ShieldAlert, PiggyBank, Zap } from "lucide-react";
import { PRICES, RESERVE, VENUES, fmt, loanHF, usd, type Asset } from "@/data";
import { DEFAULT_LEVELS, healthFactor, levelsOf, liquidationPrice, maxSafeBorrow, reservePlan, yearlyInterest } from "@/lib/loan-math";
import { blockLabel, capResetLabel, reserveBlock, reservePreview } from "@/lib/reserve";
import { alertTitle, cushionLine, needsSignatures, requiredSignatures, severity } from "@/lib/loan-copy";
import { alertOnTopic, alertOptions, optionsNote } from "@/lib/alerts";
import { testRunLine } from "@/lib/proposals";
import { agentOn, balancesOn } from "@/lib/networks";
import { useApp, type Msg, type View } from "@/store";
import { cn } from "@/lib/utils";
import { ProposalStatus } from "@/components/common";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const card = "flex flex-col gap-3 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10";

export function ProposalCard({ id }: { id: string }) {
  const { proposals } = useApp();
  const p = proposals[id];
  if (!p) return null;
  const dead = p.stage < 0;
  const done = p.stage === 3;
  const run = testRunLine(p.hfAfter, p.feeUsd);
  return (
    <div className={cn(card, dead && "gap-1", dead && !p.queued && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{p.title}</span>
        {dead && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">{p.stage === -1 ? "Rejected" : p.stage === -2 ? "Replaced" : "Out of date"}</span>}
      </div>
      {!dead && !done && <p className="text-sm">{p.outcome}</p>}
      {!dead && !done && <ol className="flex flex-col gap-1">
        {p.steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">{i + 1}</span>
            <span className="min-w-0">{s}</span>
          </li>
        ))}
      </ol>}
      {!dead && !done && <p className={cn("text-xs", run.blocked ? "text-destructive" : "text-muted-foreground")}>{run.text}</p>}

      <ProposalStatus id={id} />
    </div>
  );
}

/** The reserve option of an alert: shows what it would do, and asks before moving money without a signature. */
function UseReserveOption({ m }: { m: Extract<Msg, { role: "alert" }> }) {
  const { loans, thresholds, chooseAlert, reserveBal, policy } = useApp();
  const [open, setOpen] = useState(false);
  const l = loans.find((x) => x.id === m.snap.id);
  if (!l) return null;
  const target = (thresholds[l.id] ?? { warn: 1.6 }).warn;
  const loan = { amount: l.collAmount, price: PRICES[l.collAsset], lt: l.lt, debt: l.debt };
  const bal = { coll: reserveBal[l.collAsset], stable: reserveBal[l.debtAsset] };
  const block = reserveBlock(loan, target, bal, policy);
  const plan = block ? null : reservePlan(loan, target, bal, policy, true);
  const done = m.chosen === "reserve";
  const sub = done
    ? "Done, no signature needed"
    : plan
      ? `${reservePreview(plan, l.collAsset, l.debtAsset)} · health factor ${plan.hfAfter.toFixed(2)}`
      : blockLabel(block ?? "noBalance", { hf: healthFactor(loan.amount * loan.price, loan.lt, loan.debt), target, coll: l.collAsset, debt: l.debtAsset, reset: capResetLabel(policy.usedSince, Date.now()) });
  const capLeft = Math.max(0, policy.dailyCapUsd - policy.usedUsd24h);
  return (
    <>
      <Button variant={done ? "default" : "secondary"} disabled={!!m.chosen || !plan} onClick={() => setOpen(true)} className="h-auto justify-between gap-2 py-2 whitespace-normal disabled:opacity-100">
        <span className="flex flex-col items-start text-left">
          <span className={cn("flex items-center gap-1.5", !plan && !done && "opacity-50")}><PiggyBank /> Use reserve now</span>
          {plan && !done && <span className="flex items-center gap-1 text-xs font-medium"><Zap aria-hidden className="size-3.5 text-warning" />Runs now, without a signature</span>}
          <span className={cn("text-xs", !!m.chosen || !plan ? "text-muted-foreground" : "opacity-80")}>{sub}</span>
        </span>
      </Button>
      {plan && (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Use {usd(plan.usd)} from reserve?</AlertDialogTitle>
              <AlertDialogDescription className="flex flex-col gap-1">
                <span className="font-medium text-foreground">This runs right away, without a signature.</span>
                <span>
                  {[plan.supply > 0 && `Supply ${fmt(plan.supply, 2)} ${l.collAsset}`, plan.repay > 0 && `repay ${fmt(plan.repay)} ${l.debtAsset}`].filter(Boolean).join(" and ").replace(/^./, (c) => c.toUpperCase())} on {l.venue} from {RESERVE.name}.
                </span>
                <span>Health {plan.hfBefore.toFixed(2)} → {plan.hfAfter.toFixed(2)}.</span>
                <span>Uses {usd(plan.usd)} of today's {usd(policy.dailyCapUsd)} limit. {usd(Math.max(0, capLeft - plan.usd))} left for other loans.</span>
                {plan.unmet && <span>This does not reach {target.toFixed(2)}. I'll draft the rest for you to sign.</span>}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => { setOpen(false); chooseAlert(m.id, "reserve"); }}>Use {usd(plan.usd)} from reserve</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

export function AlertCard({ m }: { m: Extract<Msg, { role: "alert" }> }) {
  const { thresholds, chooseAlert, reserveLinked, alertStateOf, fixWithAgent, loans, safes, safe, view, proposals } = useApp();
  const [shownFor, setShownFor] = useState<View | null>(null);
  // The card is a snapshot of the moment the alert fired. alertStateOf compares it with the live loan.
  const l = m.snap;
  const state = alertStateOf(m);
  const liveLoan = loans.find((x) => x.id === m.loanId);
  const liveHf = liveLoan ? loanHF(liveLoan) : 0;
  const act = levelsOf(thresholds, l.id).act;
  const sf = safes.find((x) => x.id === m.safeId) ?? safe;
  const opts = alertOptions(m, balancesOn(sf, m.snap.network));
  const note = optionsNote(opts, l.collAsset);
  const fixTag = Object.values(proposals).some((p) => p.loanId === m.loanId && p.stage === 0) ? "Fix drafted" : "Fix waiting for signatures";

  if (state !== "live" && state !== "chosen") {
    const tag = { replaced: "Newer alert below", resolved: "Resolved", closed: "Loan closed", outdated: "Out of date", fixing: fixTag }[state];
    return (
      <div className={cn(card, "gap-2", state !== "outdated" && state !== "fixing" && "opacity-60")}>
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium">{l.venue} alert at health factor {m.hf.toFixed(2)}</span>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">{tag}</span>
        </div>
        {(state === "resolved" || state === "outdated" || state === "fixing") && <p className="text-xs text-muted-foreground">Health factor is now {liveHf.toFixed(2)}.</p>}
        {state === "outdated" && <Button size="sm" variant="outline" className="self-start" onClick={() => fixWithAgent(m.loanId)}>Get new options</Button>}
      </div>
    );
  }
  const sigs = requiredSignatures(sf.threshold);
  const onTopic = alertOnTopic(view, m.loanId);
  if (state === "live" && !onTopic && shownFor !== view) {
    return (
      <div className={cn(card, "flex-row items-center gap-2 bg-destructive/10 ring-1 ring-destructive/30")}>
        <ShieldAlert className="size-4 shrink-0 text-destructive-text" />
        <span className="min-w-0 flex-1 font-medium text-destructive-text">{alertTitle(l.venue, m.hf)}</span>
        <Button variant="ghost" size="xs" onClick={() => setShownFor(view)}>Show options</Button>
      </div>
    );
  }
  return (
    <div className={cn(card, "bg-destructive/10 ring-1 ring-destructive/30")}>
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2 font-medium text-destructive-text">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{alertTitle(l.venue, m.hf)}</span>
          {state === "chosen" && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-foreground">{fixTag}</span>}
          {state === "live" && !onTopic && <Button variant="ghost" size="xs" onClick={() => setShownFor(null)}>Hide options</Button>}
        </div>
        <p className="text-sm">{cushionLine(l.collAsset, m.price, liquidationPrice(l.collAmount, l.lt, l.debt), l.debt)}</p>
        <p className="text-xs text-muted-foreground">{m.why ? `${m.why} ` : ""}Health factor {m.hf.toFixed(2)}, below your At-risk level of {act}.{severity(m.hf) === "now" && ` Liquidation means the lender can sell some of your ${l.collAsset} to repay the loan, usually with a penalty.`}</p>
      </div>
      {state === "chosen" ? (
        <p className="text-xs text-muted-foreground">{m.chosen === "reserve" ? "The reserve covered part. The rest is drafted below." : `${opts.find((o) => o.k === m.chosen)?.label} is drafted below.`}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {opts.map((o) => {
              const off = o.short || !agentOn(sf, m.snap.network);
              return (
                <Button key={o.k} variant="outline" disabled={off} onClick={() => chooseAlert(m.id, o.k)} className="h-auto min-h-11 flex-col items-start gap-0 py-2 whitespace-normal disabled:opacity-100">
                  <span className={cn("flex w-full items-start gap-2 text-left", off && "opacity-50")}>
                    <span className="min-w-0 flex-1">{o.label}</span>
                    {o.recommended && agentOn(sf, m.snap.network) && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-normal">Recommended</span>}
                  </span>
                  <span className={cn("text-left text-xs font-normal", off ? "text-muted-foreground" : "opacity-80")}>{o.sub}{!o.short && ` · ${needsSignatures(sigs)}`}</span>
                </Button>
              );
            })}
            {agentOn(sf, m.snap.network) && note && <p className="text-xs text-muted-foreground">{note}</p>}
            {agentOn(sf, m.snap.network) && opts.some((o) => o.short) && <p className="text-xs text-muted-foreground">Greyed options need more than this Safe holds. Move funds into the Safe first, or pick another option.</p>}
            {reserveLinked && <UseReserveOption m={{ ...m, chosen: undefined }} />}
          </div>
          {!agentOn(sf, m.snap.network) && <p className="text-xs text-muted-foreground">Add the agent to this Safe to draft a fix.</p>}
        </>
      )}
    </div>
  );
}

export function ReserveActionCard({ m }: { m: Extract<Msg, { role: "reserve" }> }) {
  const { go } = useApp();
  return (
    <div className={cn(card, "ring-1 bg-status-working/10 ring-status-working/40")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-status-working"><PiggyBank className="size-3.5" /> Executed by agent from Reserve Safe</span>
      </div>
      <span className="font-medium">{m.title}</span>
      <ol className="flex flex-col gap-1">
        {m.steps.map((s, i) => (
          <li key={i} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" /><span className="min-w-0">{s}</span></li>
        ))}
      </ol>
      <p>Health <span className="font-medium">{m.hfBefore.toFixed(2)} → {m.hfAfter.toFixed(2)}</span></p>
      <p className="text-xs text-muted-foreground">{m.capLine} · {m.leftLine}</p>
      {m.note && <p className="text-xs">{m.note}</p>}
      <Button variant="link" className="self-start px-0" onClick={() => go({ name: "reserve" })}>Change reserve policy</Button>
    </div>
  );
}

export { Check };
