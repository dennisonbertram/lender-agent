"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useCloseLoan } from "@/client/close";
import { clearRepayIntent, newRepayIdempotencyKey, readRepayIntent, useRepayLoan, writeRepayIntent, type RepayIntent } from "@/client/repay";
import { useLoan, type LoanDetail } from "@/client/loans";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoanCharts } from "@/components/charts";
import { NetworkChip, PageHeader, Panel, Stat, StatusPill, textClass } from "@/components/common";
import { LoanRisk } from "@/components/fixes/LiveFix";
import { ProposalCardSlot } from "@/components/chat/ProposalCardSlot";
import { useSafeNickname, useShell } from "@/components/shell/ShellContext";
import { centDigits, fmt, usd } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StateMessage } from "@/components/ui/state-message";
import { describeError } from "@/lib/errors";
import { riskHeadline, watchLine } from "@/lib/loan-copy";
import { firstCheckLine, watchLine as monitorWatchLine } from "@/lib/watch-copy";
import { AddressText, TxHashLink } from "@/components/ui/address";
import { explorerBaseUrl } from "@/lib/explorer";
import { safePaths } from "@/components/shell/Sidebar";
import { ApiError } from "@/client/safes";

/** A small "i" button: the text is its name and its tooltip, reachable by keyboard. */
function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label={text} title={text} className="inline-flex size-5 items-center justify-center rounded-full border border-edge text-xs leading-none text-muted-foreground pointer-coarse:size-8" />}>
        <span aria-hidden>i</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

const when = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** One freshness line under the status pill: "Checked 07:30 PM · block 57,172,001" (the block links to the explorer). */
function Freshness({ m, chainId, block, readAt, failing }: { m: LoanDetail["monitor"]; chainId: number; block: number; readAt: number; failing: boolean }) {
  const base = explorerBaseUrl(chainId);
  const blockText = block.toLocaleString("en-US");
  let head: string;
  if (m.state === "not_watched") head = "Not watched";
  else if (m.state === "failing") head = monitorWatchLine("lagging", { statuses: [], lastCheckAt: m.lastCheckAt, now: Date.now(), firstCheckDue: m.firstCheckDue });
  else if (m.state === "starting" && !m.lastCheckAt) head = firstCheckLine(failing);
  else head = `Checked ${when(m.lastCheckAt ? new Date(m.lastCheckAt).getTime() : readAt)}`;
  return (
    <p className="text-sm text-foreground/70" data-testid="monitor-line">
      {head.replace(/\.$/, "")} · block{" "}
      {base ? <a href={`${base}/block/${block}`} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">{blockText}</a> : blockText}
    </p>
  );
}

/** Where the loan lives on-chain, for anyone who wants to check it. Collapsed: most people never open it. */
function OnchainDetails({ l, openedTx }: { l: LoanDetail["loan"]; openedTx: string | null }) {
  const token = (t: { symbol: string; address: string }) => (
    <AddressText address={t.address} chainId={l.chainId} label={`${t.symbol === "WETH" ? "ETH (WETH)" : t.symbol}`} />
  );
  return (
    <details className="rounded-lg border border-edge px-3 py-2 text-sm" data-testid="onchain-details">
      <summary className="cursor-pointer select-none font-medium">On-chain details</summary>
      <dl className="mt-2 flex flex-col gap-2">
        <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{l.onchain.market.kind === "id" ? "Market id" : "Lending contract"}</dt>
          <dd className="min-w-0">{l.onchain.market.kind === "address" ? <AddressText address={l.onchain.market.value} chainId={l.chainId} /> : <span title={l.onchain.market.value} className="font-mono">{l.onchain.market.value.slice(0, 10)}…{l.onchain.market.value.slice(-4)}</span>}</dd></div>
        {l.onchain.collateral.map((t) => <div key={`c${t.address}`} className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">Collateral token</dt><dd className="min-w-0">{token(t)}</dd></div>)}
        {l.onchain.debt.map((t) => <div key={`d${t.address}`} className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">Debt token</dt><dd className="min-w-0">{token(t)}</dd></div>)}
        {openedTx && <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">Opened in</dt><dd className="min-w-0"><TxHashLink chainId={l.chainId} hash={openedTx} /></dd></div>}
      </dl>
    </details>
  );
}

/** Repay part of the loan from the Safe's USDC, or close it entirely. The typed amount goes into the proposal verbatim; the owners sign in Safe. Not offered when the account holds other assets (mixed). */
function CloseLoan({ address, loanId, openProposalIds, chatHref, owed, safeName, repaymentEligible = true, repaymentUnavailableReason }: { address: string; loanId: string; openProposalIds: string[]; chatHref: string; owed: number; safeName: string; repaymentEligible?: boolean; repaymentUnavailableReason?: string }) {
  const close = useCloseLoan(address, loanId);
  const repay = useRepayLoan(address, loanId);
  const [text, setText] = useState("");
  const [intentReady, setIntentReady] = useState(false);
  const [savedIntent, setSavedIntent] = useState<RepayIntent | null>(null);
  const openKey = openProposalIds.join("|");
  useEffect(() => {
    setIntentReady(false);
    let saved = readRepayIntent(address, loanId);
    if (saved?.proposalId && !openProposalIds.includes(saved.proposalId)) {
      clearRepayIntent(address, loanId);
      saved = null;
    }
    setSavedIntent(saved);
    setText(saved ? String(saved.amount) : "");
    setIntentReady(true);
  }, [address, loanId, openKey]);
  const trimmed = text.trim();
  const amount = Number(trimmed);
  // Ordinary decimal strings only: "1e3", "0x10" or words are a hint, never a Number() parse.
  // The repay is supported to the cent; more decimals never reach the builder (the server refuses too).
  const DECIMAL = /^\d+(\.\d{0,2})?$/;
  const excessDecimals = /^\d+\.\d{3,}$/.test(trimmed);
  const notNumber = trimmed !== "" && !DECIMAL.test(trimmed) && !excessDecimals;
  const valid = DECIMAL.test(trimmed) && amount > 0 && amount < owed && repaymentEligible;
  const tooMuch = DECIMAL.test(trimmed) && amount >= owed;
  const remaining = Math.max(0, owed - amount);
  const retryingUnconfirmed = !!savedIntent && !savedIntent.proposalId;
  const alreadyQueued = !!savedIntent?.proposalId || (openProposalIds.length > 0 && !retryingUnconfirmed);
  const repayDisabled = !intentReady || alreadyQueued || repay.isPending || (!retryingUnconfirmed && (!repaymentEligible || !valid));

  async function submitRepayment() {
    const recovering = savedIntent && !savedIntent.proposalId ? savedIntent : null;
    if ((!recovering && !valid) || alreadyQueued || !intentReady) return;
    const existing = savedIntent && Math.round(savedIntent.amount * 100) === Math.round(amount * 100) ? savedIntent : null;
    const next = recovering ?? existing ?? { amount, idempotencyKey: newRepayIdempotencyKey() };
    writeRepayIntent(address, loanId, next);
    setSavedIntent(next);
    try {
      const result = await repay.mutateAsync({ amount: next.amount, idempotencyKey: next.idempotencyKey });
      const confirmed = { ...next, proposalId: result.proposalId };
      setSavedIntent(confirmed);
      writeRepayIntent(address, loanId, confirmed);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 422 || error.stage === "not_sent")) {
        clearRepayIntent(address, loanId);
        setSavedIntent(null);
      }
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground" aria-hidden>$</span>
          <Input
            aria-label="Amount to repay"
            inputMode="decimal"
            placeholder="0.0"
            autoComplete="off"
            value={text}
            disabled={!intentReady || alreadyQueued || retryingUnconfirmed || repay.isPending || !repaymentEligible}
            aria-invalid={tooMuch || excessDecimals || notNumber || undefined}
            className="w-28"
            onChange={(e) => setText(e.target.value)}
          />
          <Button variant="outline" disabled={repayDisabled} onClick={() => void submitRepayment()}>{retryingUnconfirmed ? "Check repayment status" : "Review repayment"}</Button>
        </div>
        <Button variant="outline" disabled={close.isPending || !!savedIntent} onClick={() => close.mutate()}>Close this loan</Button>
        <Button variant="ghost" render={<Link href={chatHref} />}>Ask the agent</Button>
      </div>
      {valid && (
        <p className="text-sm" data-testid="repay-review">
          Use {usd(amount, centDigits(amount))} in digital dollars from {safeName}. About {usd(remaining, centDigits(remaining))} will still be owed. Your collateral stays locked.
        </p>
      )}
      <p className="text-sm text-muted-foreground" data-testid="close-hint">Your Safe owners approve in Safe before the repayment runs.</p>
      {!repaymentEligible && <p className="text-sm text-muted-foreground" data-testid="repay-unavailable">{repaymentUnavailableReason ?? "Partial repayment is unavailable for this loan."}</p>}
      {alreadyQueued && <p className="text-sm text-muted-foreground" data-testid="repay-pending">A proposal for this loan is already in Safe. Review it above before starting another repayment.</p>}
      {retryingUnconfirmed && <p className="text-sm text-muted-foreground" data-testid="repay-recovery">The request may have reached Safe. Check its status using the same amount before starting another repayment.</p>}
      {notNumber && <p className="text-sm" data-testid="repay-hint">Enter dollars and cents, like 200 or 200.50.</p>}
      {excessDecimals && <p className="text-sm" data-testid="repay-hint">Repay in whole cents — up to two decimals, like 200.50.</p>}
      {tooMuch && <p className="text-sm" data-testid="repay-hint">That covers the whole debt — use "Close this loan" to repay it all and get your collateral back.</p>}
      {(close.isError || repay.isError) && (
        <div role="alert" className="text-sm">
          <p>{close.error?.message ?? repay.error?.message}</p>
          {repay.error instanceof ApiError && repay.error.status === 409 && (
            <p>To review an earlier request for this loan, <Link className="underline underline-offset-4" href={safePaths(address).activity}>open Activity</Link>.</p>
          )}
        </div>
      )}
      {repay.data && !openProposalIds.includes(repay.data.proposalId) && <ProposalCardSlot safeAddress={address} proposalId={repay.data.proposalId} />}
      {close.data && !openProposalIds.includes(close.data.proposalId) && <ProposalCardSlot safeAddress={address} proposalId={close.data.proposalId} />}
    </div>
  );
}

/** One loan: health, borrowed, collateral and interest tiles, the limit bar, history, open proposals. */
export function LoanDashboard({ address, loanId }: { address: string; loanId: string }) {
  const { safe, failing } = useShell();
  const { safeName } = useSafeNickname();
  const displaySafeName = safeName(safe.address, safe.name);
  const q = useLoan(address, loanId);
  if (!q.data) {
    const e = q.error ? describeError(q.error, "loan", { retry: () => void q.refetch(), backHref: safePaths(address).overview }) : null;
    return (
      <div className="p-4 md:p-6">
        {e ? <StateMessage kind="error" title={e.title} reason={e.reason} action={e.primary} secondary={e.secondary} /> : <StateMessage kind="loading" label="Loading your loan…" />}
      </div>
    );
  }

  const { loan: l, history, openProposalIds, price, monitor, openedTx } = q.data;
  const hf = l.healthFactor ?? Number.POSITIVE_INFINITY;
  const s = l.status;
  const asset = l.collateral.length === 1 ? l.collateral[0].asset : "collateral";
  const collUsd = l.collateral.some((c) => c.usd === null) ? null : l.collateral.reduce((n, c) => n + (c.usd ?? 0), 0);
  const collText = collUsd === null ? "Price unavailable" : usd(collUsd);

  return (
    <div className="@container flex flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title={`${l.lender} · ${asset}`}
        sub={<span className="flex flex-wrap items-center gap-x-1.5">Borrowing {l.debt.asset} · {displaySafeName} · <NetworkChip id={l.network} className="px-1.5 py-0" /></span>}
        right={<StatusPill s={s} />}
      />
      <div className="-mt-2 flex flex-col gap-1">
        <AddressText address={safe.address} chainId={l.chainId} label="Safe" showSafeApp className="text-sm" />
        <Freshness m={monitor} chainId={l.chainId} block={l.blockNumber} readAt={l.readAt} failing={!!failing} />
      </div>
      <p className="text-sm">{l.lender.toLowerCase().includes("compound") ? `If this loan is liquidated, Compound takes all collateral from the account and credits any remainder in USDC.` : riskHeadline(l) ?? (l.liquidationPrice !== null ? `If ${asset} drops below ${usd(l.liquidationPrice)}, the lender can sell some collateral.` : `${l.canFallPct}.`)}</p>
      {s === "watch" && l.watched && (monitor.state === "watching" || monitor.state === "starting") && (
        <p className="text-sm text-muted-foreground" data-testid="watch-line">{watchLine(l.levels.act)}</p>
      )}
      <LoanRisk address={address} loanId={l.id} hf={hf} atRisk={l.healthFactor !== null && (s === "risk" || s === "liquidatable")} />

      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
        <Stat label="Borrowed" value={l.debt.amount === null ? "Debt value unavailable" : `${fmt(l.debt.amount)} ${l.debt.asset}`} sub={l.debt.usd === null ? undefined : usd(l.debt.usd)} />
        <Stat
          label="Collateral"
          value={l.collateral.map((c) => `${fmt(c.amount, 2)} ${c.asset}`).join(" + ")}
          sub={l.collateralPrice === null ? collText : `${collText} · ${asset} now ${usd(l.collateralPrice)}`}
        />
        <Stat
          label="Interest"
          value={l.apr === null ? "Not shown" : `${l.apr}% a year`}
          sub={l.yearlyInterest === null ? undefined : `Variable · about ${usd(l.yearlyInterest, 0)} a year`}
        />
      </div>

      <details className="rounded-lg border border-edge px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none font-medium">Health details</summary>
        <div className="mt-2 flex flex-col gap-2">
          <Stat label="Health factor" value={l.healthFactor === null ? l.debt.amount === 0 ? "No debt" : l.debt.asset === "USD" ? "Debt unavailable" : "Health unavailable" : hf.toFixed(2)} className={textClass[s]} sub={<InfoHint text={`Higher is safer. Below 1.0 the lender can sell your ${asset}.`} />} />
          <p className="text-xs text-muted-foreground">Higher is safer. Below 1.0, the lender can sell collateral to repay the loan.</p>
        </div>
      </details>

      {l.mixed ? (
        <Panel title="Health factor · 30 days">
          <p className="text-sm text-muted-foreground">Charts need a single collateral asset. This loan holds several, so health and the price cushion are shown above without a liquidation price.</p>
        </Panel>
      ) : l.debt.usd === null ? (
        <Panel title="Health chart unavailable">
          <p className="text-sm text-muted-foreground">The loan's dollar debt value is unavailable, so the chart cannot estimate a liquidation price.</p>
        </Panel>
      ) : (
        <LoanCharts loan={{ collAsset: l.shell.collAsset, debt: l.debt.usd }} hf={hf} t={l.levels} price={price} history={history} />
      )}

      <div className={openProposalIds.length ? "grid gap-4 @2xl:grid-cols-2" : "grid gap-4"}>
        {openProposalIds.length > 0 && (
          <Panel title="Proposals">
            <ul className="flex flex-col gap-2">
              {openProposalIds.map((id) => <li key={id}><ProposalCardSlot safeAddress={address} proposalId={id} /></li>)}
            </ul>
          </Panel>
        )}
      </div>
      {!l.mixed && l.watched && l.debt.amount !== null && <CloseLoan address={address} loanId={loanId} openProposalIds={openProposalIds} chatHref={safePaths(address).chat} owed={l.debt.amount} safeName={displaySafeName} repaymentEligible={l.repaymentEligible} repaymentUnavailableReason={l.repaymentUnavailableReason} />}
      {!l.mixed && l.watched && l.debt.amount === null && <p className="text-sm text-muted-foreground">Repayment controls are unavailable because the debt value could not be confirmed.</p>}
      <OnchainDetails l={l} openedTx={openedTx} />
    </div>
  );
}
