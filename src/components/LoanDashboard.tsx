import { MessageSquare, TriangleAlert } from "lucide-react";
import { PRICES, fmt, loanHF, networkName, usd } from "@/data";
import { cushionLine, demoDropNote, limitBar, limitUsedPct, riskBanner } from "@/lib/loan-copy";
import { liquidationPrice } from "@/lib/loan-math";
import { useApp, useStatus } from "@/store";
import { Panel, PageHeader, ProposalStatus, Stat, StatusPill, textClass } from "@/components/common";
import { Button } from "@/components/ui/button";
import { LoanCharts } from "@/components/charts";
import { SafeHome } from "@/components/SafeHome";

export function LoanDashboard({ id }: { id: string }) {
  const { loans, thresholds, proposals, simulateDrop, fixWithAgent, safe } = useApp();
  const status = useStatus();
  const l = loans.find((x) => x.id === id);
  if (!l) return <SafeHome />;

  const hf = loanHF(l);
  const s = status(l);
  const t = thresholds[l.id] ?? { warn: 1.6, act: 1.35 };
  const price = PRICES[l.collAsset];
  const liq = liquidationPrice(l.collAmount, l.lt, l.debt);
  const collValue = l.collAmount * price;

  const used = limitUsedPct(hf);

  const open = Object.values(proposals).filter((p) => p.loanId === l.id && p.stage >= 0 && p.stage <= 2);
  const fix = open.some((p) => p.stage >= 1) ? "queued" : open.length ? "draft" : "none";

  return (
    <div className="@container flex flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title={`${l.venue} · ${l.collAsset}`}
        sub={`Borrowing ${l.debtAsset} · ${safe.name} · ${networkName(l.network)}`}
        right={<StatusPill s={s} />}
      />

      <p className="text-sm">{cushionLine(l.collAsset, price, liq, l.debt)}</p>

      {(s === "risk" || s === "liquidatable") && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive-text ring-1 ring-destructive/30">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="flex min-h-7 min-w-0 flex-1 items-center">
            {riskBanner(hf, fix)}
          </span>
          {fix !== "queued" && (
            <Button variant="destructive" size="sm" onClick={() => fixWithAgent(l.id)}>
              <MessageSquare /> {fix === "draft" ? "Review fix" : "Fix with agent"}
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Stat label="Health factor" value={Number.isFinite(hf) ? hf.toFixed(2) : "∞"} className={textClass[s]} sub="Liquidated below 1.0" />
        <Stat label="Borrowed" value={`${fmt(l.debt)} ${l.debtAsset}`} />
        <Stat label="Collateral" value={`${fmt(l.collAmount, 2)} ${l.collAsset}`} sub={`${usd(collValue)} · ${l.collAsset} now ${usd(price)}`} />
        <Stat label="Interest" value={`${l.apr.toFixed(1)}% a year`} sub={`Variable · ${usd(l.accrued, 2)} added so far`} />
      </div>

      <LoanCharts loan={l} hf={hf} t={t} />

      <div className={open.length ? "grid gap-4 @2xl:grid-cols-2" : "grid gap-4"}>
        <Panel title="Loan limit">
          <Bar label="Used" tone={s === "risk" || s === "liquidatable" ? "bg-destructive" : s === "watch" ? "bg-warning" : "bg-success"} {...limitBar(used)} />
        </Panel>

        {open.length > 0 && (
          <Panel title="Proposals">
            <ul className="flex flex-col gap-2">
              {open.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 rounded-lg bg-muted p-3">
                  <span className="min-w-0 truncate text-sm">{p.title}</span>
                  <ProposalStatus id={p.id} compact />
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      <div role="group" aria-label="Demo controls" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Demo only: drop the {l.collAsset} price</span>
        {[8, 25].map((p) => (
          <Button key={p} variant="outline" size="xs" className="pointer-coarse:min-w-11" onClick={() => simulateDrop(l.id, p)}>−{p}%</Button>
        ))}
        <span>{demoDropNote(l.collAsset)}</span>
      </div>
    </div>
  );
}

function Bar({ label, fill, tick, tone, text }: { label: string; fill: number; tick: number | null; tone: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="truncate">{text}</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted ring-1 ring-inset ring-edge">
        <div className={`h-2 rounded-full ${tone}`} style={{ width: `${fill}%` }} />
        {tick !== null && <span aria-hidden className="absolute -top-0.5 h-3 w-0.5 rounded-full bg-foreground" style={{ left: `${tick}%` }} />}
      </div>
    </div>
  );
}
