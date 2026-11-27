"use client";
import Link from "next/link";
import { Banknote } from "lucide-react";
import { useProposals } from "@/client/proposals";
import { useLoans, type LoanView, type LoansResult } from "@/client/loans";
import { AddFundsBody, CanCannot, HealthDot, NetworkChip, PageHeader, Panel, StatusPill, networkLabel, statusLabel, textClass } from "@/components/common";
import { FixWaitingLines } from "@/components/fixes/LiveFix";
import { safePaths } from "@/components/shell/Sidebar";
import { useSafeNickname, useShell } from "@/components/shell/ShellContext";
import { Button } from "@/components/ui/button";
import { shortAddress } from "@/lib/address";
import { AddressText } from "@/components/ui/address";
import { AgentWatchStatus, useWatchStatus } from "@/components/agent/AgentWatchStatus";
import { SAFE_NETWORKS } from "@/lib/safe-create";
import { fmt, usd } from "@/lib/format";
import { StateMessage } from "@/components/ui/state-message";
import { describeError } from "@/lib/errors";
import { attentionCounts, riskHeadline } from "@/lib/loan-copy";
import { watchLine } from "@/lib/watch-copy";
import { actionLabel, describe } from "@/components/proposals/review-state";
import { SendToSafe } from "@/components/wallet/SendToSafe";
import { GuideIntro } from "@/components/guide/Guide";

type RepaymentNeed = { chainId: number; network: string; shortfall: number | null; balanceKnown: boolean; otherDebt: boolean };
const tokenAmount = (amount: number, decimals: number) => amount.toLocaleString("en-US", { maximumFractionDigits: decimals });

function repaymentNeeds(loans: LoanView[], balancesByNetwork: LoansResult["balancesByNetwork"]): RepaymentNeed[] {
  const groups = new Map<number, { network: string; due: number; otherDebt: boolean }>();
  for (const loan of loans) {
    if (loan.debt.asset !== "USDC" || loan.debt.amount === null || loan.debt.amount <= 0) continue;
    const group = groups.get(loan.chainId) ?? { network: loan.network, due: 0, otherDebt: false };
    group.due += loan.debt.amount;
    groups.set(loan.chainId, group);
  }
  return [...groups.entries()].flatMap<RepaymentNeed>(([chainId, group]) => {
    const networkLoans = loans.filter((loan) => loan.chainId === chainId);
    group.otherDebt = networkLoans.some((loan) => loan.debt.asset !== "USDC" && (loan.debt.amount === null || loan.debt.amount > 0 || loan.debt.usd === null));
    const balances = balancesByNetwork.find((b) => b.chainId === chainId);
    if (!balances) return [{ chainId, network: group.network, shortfall: null, balanceKnown: false, otherDebt: group.otherDebt }];
    const held = balances.assets.find((a) => a.asset === "USDC")?.amount ?? 0;
    const shortfall = Math.max(0, group.due - held);
    return shortfall > 0 ? [{ chainId, network: group.network, shortfall, balanceKnown: true, otherDebt: group.otherDebt }] : [];
  });
}

function RepaymentFunding({ address, needs }: { address: string; needs: RepaymentNeed[] }) {
  if (!needs.length) return null;
  return (
    <section data-testid="repayment-funding" className="flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
      <h4 className="font-medium">USDC repayment guidance</h4>
      {needs.map((need) => (
        <div key={need.chainId} className="flex flex-col gap-2">
          <p>{need.balanceKnown ? `About ${tokenAmount(need.shortfall ?? 0, 6)} USDC more on ${networkLabel(need.network)} based on current balances.` : `I can't confirm the Safe's USDC balance on ${networkLabel(need.network)}, so I can't estimate how much more to add.`}</p>
          {need.otherDebt && <p className="text-xs text-muted-foreground">This estimate covers USDC-denominated loans only. Other debt on this network may need a different asset.</p>}
          <p className="text-xs text-muted-foreground">Keep USDC on the same network as the loan. Accrued interest and the signing buffer can make the amount higher. Closing still needs Safe-owner signatures.</p>
          <details className="rounded-md border border-edge p-2"><summary className="cursor-pointer font-medium">Send USDC to this Safe</summary><div className="pt-2"><SendToSafe safe={address} chainIds={[need.chainId]} assets={["USDC"]} /></div></details>
        </div>
      ))}
    </section>
  );
}

/** The Proposer's limits, as the mockup words them on the agent-off panel. */
const PROPOSER_CAN = ["Read your Safe and your loans", "Watch health and alert you", "Suggest fixes you can review and sign"];
const PROPOSER_CANNOT = ["Sign for your Safe", "Move money without your signatures", "Execute anything"];

/** "0.62 ETH locked" / "2 assets locked". */
function lockedText(l: LoanView): string {
  if (l.collateral.length === 1) return `${fmt(l.collateral[0].amount, 2)} ${l.collateral[0].asset} locked`;
  return `${l.collateral.length} assets locked`;
}
/** The known token amount stays visible when its USD value is unavailable. */
function owedText(d: LoanView["debt"]): string {
  if (d.asset === "USD") return d.usd === null ? "Debt value unavailable" : `${usd(d.usd)} owed`;
  if (d.amount === null) return "Debt amount unavailable";
  if (d.usd === null) return `${tokenAmount(d.amount, d.asset === "USDC" || d.asset === "DAI" ? 6 : 8)} ${d.asset} owed · value unavailable`;
  return `${usd(d.usd)} ${d.asset} owed`;
}

function LoanRow({ l, address }: { l: LoanView; address: string }) {
  const asset = l.collateral.length === 1 ? l.collateral[0].asset : "collateral";
  const debtIsKnown = l.debt.asset === "USD" ? l.debt.amount !== null && l.debt.amount > 0 : (l.debt.amount ?? 0) > 0;
  const debtMayExist = l.debt.amount === null || debtIsKnown || (l.debt.asset === "USD" && l.debt.usd === null);
  return (
    <li>
      <Link href={safePaths(address).loan(encodeURIComponent(l.id))} className="flex w-full items-center gap-3 rounded-lg bg-muted p-3 text-left text-sm transition-colors hover:bg-muted/70">
        <HealthDot s={l.status} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span>{l.lender} · {asset}</span><NetworkChip id={l.network} /></span>
          {(l.healthFactor !== null || debtMayExist) && <span className="block text-xs">{lockedText(l)} · {owedText(l.debt)}</span>}
          <span className="block text-xs text-muted-foreground">{l.canFallPct}</span>
        </span>
        {l.status === "liquidatable" && l.healthFactor !== null
          ? <StatusPill s={l.status} hf={l.healthFactor} />
          : l.healthFactor === null
            ? <span className={`shrink-0 whitespace-nowrap text-xs tabular-nums ${textClass[l.status]}`}>{debtMayExist ? l.debt.asset === "USD" ? "Debt unavailable" : "Health unavailable" : "No debt"}</span>
            : <span className="flex shrink-0 flex-col items-end text-xs tabular-nums"><span className={textClass[l.status]}>{statusLabel[l.status]}</span><span className="text-muted-foreground">Health {l.healthFactor.toFixed(2)}</span></span>}
      </Link>
    </li>
  );
}

/** Safe overview: are my loans fine, plus the states for agent not added, needs funding, or no loans yet. */
export function SafeOverview() {
  const { safe, agentOn } = useShell();
  const { safeName } = useSafeNickname();
  const q = useLoans(safe.address);
  const pq = useProposals(safe.address, { open: true });
  const displayName = safeName(safe.address, safe.name);
  const unnamed = displayName === shortAddress(safe.address);
  const nets = safe.networks.filter((n) => n.deployed);
  const chainId = SAFE_NETWORKS.find((n) => n.name.toLowerCase() === (nets[0] ?? safe.networks[0])?.id)?.chainId;
  const watch = useWatchStatus(pq.data?.filter((p) => !p.final).length ?? 0);
  const header = (
    <PageHeader
      title={unnamed ? "Your Safe" : displayName}
      sub={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AddressText address={safe.address} chainId={chainId} showSafeApp />
          {nets.map((n) => <NetworkChip key={n.id} id={n.id} />)}
          <span>· {safe.threshold} owners must sign</span>
        </span>
      }
    />
  );
  if (!q.data) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        {header}
        {q.error
          ? (() => { const e = describeError(q.error, "loans", { retry: () => void q.refetch(), backHref: safePaths(safe.address).overview }); return <StateMessage kind="error" title={e.title} reason={e.reason} action={e.primary} secondary={e.secondary} />; })()
          : <StateMessage kind="loading" label="Loading your loans…" />}
      </div>
    );
  }
  const { loans, balancesByNetwork, sentence, watched, loanReadsComplete } = q.data;
  const act = attentionCounts(loans.map((l) => l.status)).act;
  const funded = balancesByNetwork.length > 0;
  const total = balancesByNetwork.some((g) => g.totalUsd === null) ? null : balancesByNetwork.reduce((n, g) => n + (g.totalUsd ?? 0), 0);
  const debtValues = loans.map((l) => l.debt.usd);
  const owed = !loanReadsComplete || debtValues.some((v) => v === null) ? null : debtValues.reduce<number>((n, v) => n + (v ?? 0), 0);
  const collateralValues = loans.flatMap((l) => l.collateral.map((c) => c.usd));
  const locked = !loanReadsComplete || collateralValues.some((v) => v === null) ? null : collateralValues.reduce<number>((n, v) => n + (v ?? 0), 0);
  const afterClose = total === null || owed === null || locked === null ? null : total - owed + locked;
  const repayment = repaymentNeeds(loans, balancesByNetwork);
  const addAgent = <Button className="self-start" render={<a href={`/onboarding/agent?safe=${safe.address}`} />}>Add agent to this Safe</Button>;
  const waiting = (pq.data ?? []).filter((p) => p.stage === "queued" && p.state !== "settling");
  const target = loans.find((l) => l.status === "liquidatable") ?? loans.find((l) => l.status === "risk");
  // Get cash is a nav item; the overview repeats it only as the empty state's call to action.
  const getCash = () => <Button render={<Link href={safePaths(safe.address).getCash} />}><Banknote /> Get cash</Button>;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {header}
      <GuideIntro topicId="overview" />
      {q.error && q.data && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm"><span>Could not refresh loan data. The figures below may be out of date.</span><Button size="sm" variant="outline" onClick={() => void q.refetch()}>Retry</Button></div>}
      {!watched && !agentOn && (loans.length > 0 ? (
        <Panel title="Not watched">
          <p className="text-sm text-muted-foreground">The Lender agent is not added to this Safe, so nothing is watching these loans. Add it to get alerts and suggested fixes.</p>
          {addAgent}
        </Panel>
      ) : (
        <Panel title={watchLine("off", { statuses: [], lastCheckAt: null, now: 0 })}>
          <p className="text-sm text-muted-foreground">The Lender agent cannot help with this Safe yet. Add it to start.</p>
          <CanCannot can={PROPOSER_CAN} cannot={PROPOSER_CANNOT} />
          {addAgent}
        </Panel>
      ))}
      {loans.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className={`text-lg font-medium ${act > 0 ? "text-destructive-text" : ""}`}>{sentence}</p>
            {act > 0 && target && riskHeadline(target) && <p className="text-sm" data-testid="risk-headline">{riskHeadline(target)}</p>}
            {agentOn && <AgentWatchStatus />}
            {watch.state === "lagging" && <p className="text-xs text-muted-foreground">Health below is read from the chain just now.</p>}
            <FixWaitingLines address={safe.address} />
            {act > 0 && agentOn && target && <div className="flex flex-wrap gap-2"><Button render={<Link href={safePaths(safe.address).loan(encodeURIComponent(target.id))} />}>See fix options</Button></div>}
          </div>
      )}
      {waiting.length > 0 && (() => {
        // The panel's title and each row's status come from the same state table the proposal page
        // uses, so "2 of 2 approved" can never read "needs Co-owner" here while the page says "Ready".
        const rows = waiting.map((p) => ({ p, d: describe(p, { phase: "idle", lastSignerSends: true }) }));
        const rank = (id: string) => id.startsWith("needs") || id === "approve_send_failed" || id === "would_fail" || id === "wallet_open" || id === "wallet_closed" || id === "saving" || id === "smart_account" ? 0 : id === "ready_to_send" || id === "no_fee_eth" ? 1 : id === "blocked" ? 2 : id === "sending" ? 3 : 4;
        const top = rows.reduce((a, b) => (rank(b.d.id) < rank(a.d.id) ? b : a)).d;
        return (
        <Panel title={top.pill ?? top.headline}>
          <ul className="flex flex-col gap-2">
            {rows.map(({ p, d }) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-muted p-3 text-sm">
                <span className="min-w-0">
                  <span className="block">{p.title}</span>
                  <span className="block text-xs text-muted-foreground">{p.signedCount} of {p.threshold ?? p.signedCount + p.needsSignatures} approved · {d.pill ?? d.headline}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {p.links.queue && <a href={p.links.queue} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground underline underline-offset-2">View in Safe{"{Wallet}"}</a>}
                  <Link href={`/s/${safe.address}/proposals/${encodeURIComponent(p.id)}`} className="font-medium underline underline-offset-2">{actionLabel(d)}</Link>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        );
      })()}
      {loans.length === 0 && !loanReadsComplete && <Panel title="Loans could not be fully checked"><p className="text-sm text-muted-foreground">Could not check every lending market, so some loans may be missing. Try again later.</p></Panel>}
      {loans.length > 0 && (
        <Panel title="Loans">
          <ul className="flex flex-col gap-2">{loans.map((l) => <LoanRow key={l.id} l={l} address={safe.address} />)}</ul>
        </Panel>
      )}
      {(funded || loans.length > 0) ? (
        <Panel title="In your Safe" guideTarget="overview-balances" action={<span className="text-sm tabular-nums" data-testid="in-safe">{total === null ? "Price unavailable" : usd(total)}</span>}>
          <dl className="flex flex-col gap-1 text-sm" data-testid="net-position">
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Spendable today</dt><dd className="tabular-nums">{total === null ? "Price unavailable" : usd(total)}</dd></div>
            {loans.length > 0 && <>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">You owe</dt><dd className="tabular-nums">{!loanReadsComplete ? "Loan balances incomplete" : owed === null ? "Price unavailable" : usd(owed)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Collateral locked</dt><dd className="tabular-nums">{!loanReadsComplete ? "Loan balances incomplete" : locked === null ? "Price unavailable" : usd(locked)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Estimated after closing</dt><dd className="tabular-nums">{afterClose === null ? !loanReadsComplete ? "Unavailable" : "Price unavailable" : usd(afterClose)}</dd></div>
            </>}
          </dl>
          {loans.length > 0 && <p className="text-xs text-muted-foreground">{loanReadsComplete ? "Estimate assumes all loans are closed. It excludes fees and can change with market prices." : "Some lending markets could not be checked. The total after closing is unavailable."}{balancesByNetwork.some((g) => g.assets.some((a) => a.priceBasis === "assumed $1 peg")) ? " USDC and DAI values assume a $1 peg." : ""}</p>}
          {loans.length > 0 && <RepaymentFunding address={safe.address} needs={repayment} />}
          {loans.length > 0 && <details open={!funded} className="rounded-lg border border-edge p-3 text-sm"><summary className="cursor-pointer font-medium">Add funds for collateral</summary><div className="pt-3"><AddFundsBody address={safe.address} networks={safe.networks.map((n) => n.id)} /></div></details>}
          {balancesByNetwork.map((g) => (
            <section key={g.chainId} aria-label={`Balances on ${networkLabel(g.network)}`} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2"><NetworkChip id={g.network} /><span className="text-xs text-muted-foreground tabular-nums">{g.totalUsd === null ? "Price unavailable" : usd(g.totalUsd)}</span></div>
              <ul className="flex flex-col gap-2">
                {g.assets.map(({ asset, amount, usd: value }) => (
                  <li key={asset} className="flex items-center justify-between rounded-lg bg-muted p-3 text-sm">
                    <span>{fmt(amount, asset === "USDC" || asset === "DAI" ? 0 : 2)} {asset}</span>
                    <span className="text-muted-foreground">{value === null ? "Price unavailable" : `${usd(value)}${g.assets.find((a) => a.asset === asset)?.priceBasis === "assumed $1 peg" ? " · assumed $1 peg" : ""}`}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </Panel>
      ) : loans.length === 0 && loanReadsComplete ? <Panel title="Add funds"><AddFundsBody address={safe.address} networks={safe.networks.map((n) => n.id)} /></Panel> : null}
      {loans.length === 0 && loanReadsComplete && funded && waiting.length === 0 && !pq.isPending && (
        <Panel title="No loans yet">
          <p className="text-sm text-muted-foreground">Tell me how much cash you need and I will plan a loan for you.</p>
          <span className="self-start">{getCash()}</span>
        </Panel>
      )}
    </div>
  );
}
