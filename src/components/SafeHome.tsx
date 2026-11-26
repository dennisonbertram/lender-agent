import { useState } from "react";
import { Banknote, Check, Copy, ShieldAlert } from "lucide-react";
import { PRICES, fmt, loanHF, usd } from "@/data";
import { shortAddress } from "@/lib/address";
import { balanceGroups, networkList } from "@/lib/networks";
import { useApp, useAttention, useStatus } from "@/store";
import { attentionCounts, loanRowLine, requiredSignatures, stageLine, statusSentence } from "@/lib/loan-copy";
import { liquidationPrice } from "@/lib/loan-math";
import { Panel, PageHeader, CanCannot, HealthDot, StatusPill, statusLabel, textClass, AddAgentButton, NetworkChip, OpenInSafeLink, AddFundsBody } from "@/components/common";
import { PROPOSER_CAN, PROPOSER_CANNOT } from "@/components/ReserveView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** Safe overview: are my loans fine, plus the states for agent not added, needs funding, or no loans yet. */
export function SafeHome() {
  const { safe, loans, go, fixWithAgent, activity, messages, proposals, policy, reserveLinked } = useApp();
  const status = useStatus();
  const attention = useAttention();

  const groups = balanceGroups(safe, PRICES);
  const funded = groups.length > 0;
  const header = <PageHeader title={safe.name} sub={`${shortAddress(safe.address)} · ${safe.threshold} owners must sign`} />;

  const total = groups.reduce((n, g) => n + g.usd, 0);
  const reserveEvent = activity.find((e) => e.kind === "reserve");
  const capUsed = reserveLinked && policy.usedUsd24h >= policy.dailyCapUsd;
  const waiting = [...new Set(messages.flatMap((m) => (m.role === "proposal" ? [m.proposalId] : [])))]
    .map((id) => proposals[id])
    .filter((p) => p && (p.stage === 1 || p.stage === 2));

  const statuses = loans.map(status);
  const worst = attention.worst;
  const risk = attention.risk > 0;
  const fix = () => { if (!worst) return; go({ name: "loan", id: worst.id }); fixWithAgent(worst.id); };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {header}
      {!safe.agent && (loans.length > 0 ? (
        <Panel title="Not watched">
          <p className="text-sm text-muted-foreground">The Lender agent is not added to this Safe, so nothing is watching these loans. Add it to get alerts and suggested fixes.</p>
          <AddAgentButton className="self-start" />
        </Panel>
      ) : (
        <Panel title="Agent not added">
          <p className="text-sm text-muted-foreground">The Lender agent cannot help with this Safe yet. Add it to start.</p>
          <CanCannot can={PROPOSER_CAN} cannot={PROPOSER_CANNOT} />
          <AddAgentButton className="self-start" />
        </Panel>
      ))}
      {loans.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            <p className={`text-lg font-medium ${attentionCounts(statuses).act > 0 ? "text-destructive-text" : ""}`}>{statusSentence(statuses, worst?.venue)}</p>
            {reserveEvent && (
              <p className="text-sm text-muted-foreground">
                {reserveEvent.text}{capUsed && " Today's reserve limit is used up."}{" "}
                <Button variant="link" size="inline" onClick={() => go({ name: "activity" })}>See in Activity</Button>
              </p>
            )}
            {waiting.map((p) => (
              <p key={p.id} className="text-sm text-muted-foreground">
                {p.title}: {stageLine(p.stage, requiredSignatures(safe.threshold))}{" "}
                {p.loanId && loans.some((l) => l.id === p.loanId) && (
                  <Button variant="link" size="inline" onClick={() => go({ name: "loan", id: p.loanId! })}>Open loan</Button>
                )}{" "}
                {p.loanId && loans.some((l) => l.id === p.loanId) && <span aria-hidden>· </span>}
                <OpenInSafeLink id={p.id} />
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              {worst && safe.agent && <Button variant={risk ? "default" : "outline"} onClick={fix}><ShieldAlert /> Fix {worst.venue} loan</Button>}
              <Button variant={risk ? "outline" : "default"} onClick={() => go({ name: "cash" })}><Banknote /> Get cash</Button>
            </div>
          </div>
          <Panel title="Loans">
            <ul className="flex flex-col gap-2">
              {loans.map((l) => {
                const s = status(l);
                return (
                  <li key={l.id}>
                    <button onClick={() => go({ name: "loan", id: l.id })} className="flex w-full items-center gap-3 rounded-lg bg-muted p-3 text-left text-sm transition-colors hover:bg-muted/70">
                      <HealthDot s={s} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span>{l.venue} · {l.collAsset}</span><NetworkChip id={l.network} /></span>
                        <span className="block text-xs text-muted-foreground">{loanRowLine(l.collAsset, PRICES[l.collAsset], liquidationPrice(l.collAmount, l.lt, l.debt), l.debt)}</span>
                      </span>
                      {s === "liquidatable"
                        ? <StatusPill s={s} hf={loanHF(l)} />
                        : <span className={`shrink-0 whitespace-nowrap text-xs tabular-nums ${textClass[s]}`}>{statusLabel[s]} {loanHF(l).toFixed(2)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </>
      )}
      {!funded ? (
        <Panel title="Add funds">
          <AddFundsBody />
        </Panel>
      ) : (
        <Panel title="Balances" action={<span className="flex items-center gap-2"><span className="text-sm text-muted-foreground tabular-nums">{usd(total)} total</span>
          <Dialog>
            <DialogTrigger render={<Button size="sm" variant="outline" />}>Add funds</DialogTrigger>
            <DialogContent><DialogHeader><DialogTitle>Add funds</DialogTitle></DialogHeader><AddFundsBody /></DialogContent>
          </Dialog></span>}>
          {groups.map((g) => (
            <section key={g.network} aria-label={`Balances on ${networkList([g.network])}`} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2"><NetworkChip id={g.network} /><span className="text-xs text-muted-foreground tabular-nums">{usd(g.usd)}</span></div>
              <ul className="flex flex-col gap-2">
                {g.assets.map(({ asset, amount }) => (
                  <li key={asset} className="flex items-center justify-between rounded-lg bg-muted p-3 text-sm">
                    <span>{fmt(amount, asset === "USDC" || asset === "DAI" ? 0 : 2)} {asset}</span>
                    <span className="text-muted-foreground">{usd(amount * PRICES[asset])}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </Panel>
      )}
      {loans.length === 0 && funded && (
        <Panel title="No loans yet">
          <p className="text-sm text-muted-foreground">Tell me how much cash you need and I will plan a loan for you.</p>
          <Button className="self-start" onClick={() => go({ name: "cash" })}><Banknote /> Get cash</Button>
        </Panel>
      )}
    </div>
  );
}
