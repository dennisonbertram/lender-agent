"use client";
// The Reserve page (BP-39, BP-40): link a Reserve Safe and sign the policy; once linked, the policy
// decoded from chain, the balance and today's use. Mockup: src/components/ReserveView.tsx (wording final).
// Limits are editable before signing; the page computes no figure the chain or server did not give.
import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, PenLine, PiggyBank, TriangleAlert } from "lucide-react";
import { ApiError } from "@/client/safes";
import { useLoans, type LoanView } from "@/client/loans";
import { useChangeReservePolicy, useLinkReserve, useReserve, useReserveCheck, useTurnReserveOff } from "@/client/reserve";
import { ActionFooter, CanCannot, PageHeader, Panel } from "@/components/common";
import { GuideIntro } from "@/components/guide/Guide";
import { useShell } from "@/components/shell/ShellContext";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SafeIdentity } from "@/components/wallet/SafeIdentity";
import type { Safe } from "@/lib/types";
import { AddressText } from "@/components/ui/address";
import { RESERVE_ASSET } from "@/server/reserve/constants";
import { StateMessage } from "@/components/ui/state-message";
import { Switch } from "@/components/ui/switch";
import { describeError } from "@/lib/errors";
import { usd } from "@/lib/format";
import { parseNumber } from "@/lib/loan-math";
import { reserveCopyV1 } from "@/lib/reserve-copy";
import { policyErrors } from "@/lib/reserve-policy";
import { cn } from "@/lib/utils";
import { RESERVE_ONE_LINER } from "./reserve-nav";
import { useOwnedChains } from "@/components/wallet/OwnedChains";

const bannerStyle = { success: "bg-success/10 ring-1 ring-success/30", warning: "bg-warning/10 ring-1 ring-warning/30", muted: "bg-muted text-muted-foreground" } as const;
const CHAIN_ID = 8453 as const;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_HF = "1.15";
const ASSET = RESERVE_ASSET[CHAIN_ID]!;
const exactDollars = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

function canonicalLenderId(loan: LoanView): "aave-v3" | "compound-v3" | "morpho-blue" | null {
  // LoanView.lender is a presentation label (for Aave, "Aave v3"). Its stable ID preserves the
  // machine lender identifier used by LoanPosition: `${chainId}:${safe}:${lender}`.
  const id = /^(\d+):0x[0-9a-f]{40}:(aave-v3|compound-v3|morpho-blue)$/i.exec(loan.id);
  if (!id || Number(id[1]) !== loan.chainId) return null;
  return id[2]!.toLowerCase() as "aave-v3" | "compound-v3" | "morpho-blue";
}

function isReserveCoveredLoan(loan: LoanView): boolean {
  return canonicalLenderId(loan) === "aave-v3" && loan.chainId === CHAIN_ID
    && loan.collateral.length > 0 && loan.debt.amount !== null && loan.debt.amount > 0
    && loan.onchain.debt.length === 1 && loan.onchain.debt[0]?.symbol === "USDC";
}

function lenderLabel(lender: string): string {
  if (lender === "aave-v3" || lender === "Aave v3") return "Aave v3";
  if (lender === "compound-v3" || lender === "Compound v3") return "Compound v3";
  if (lender === "morpho-blue" || lender === "Morpho Blue") return "Morpho Blue";
  return lender;
}

function coverageReason(loan: LoanView): string {
  if (canonicalLenderId(loan) !== "aave-v3" || loan.chainId !== CHAIN_ID) return "It is not a Base Aave loan";
  if (loan.onchain.debt.length > 1) return "It has mixed debt";
  if (loan.onchain.debt.length === 0) return "It has no debt to repay";
  if (loan.debt.amount === null) return "Its debt amount could not be confirmed";
  if (loan.debt.amount <= 0) return "It has no debt to repay";
  return "It does not have one USDC debt";
}

/** "What you will sign": the addresses the setup touches. Agent key and Roles modifier are known to the server only once the setup is built. */
function Involved({ rows, note }: { rows: { label: string; address: string; showSafeApp?: boolean }[]; note?: string }) {
  return (
    <details className="rounded-xl ring-1 ring-foreground/10">
      <summary className="cursor-pointer p-3 text-sm font-medium">What you will sign: the addresses involved</summary>
      <dl className="flex flex-col gap-2 px-3 pb-3 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-center justify-between gap-x-3">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd><AddressText address={r.address} chainId={CHAIN_ID} showSafeApp={r.showSafeApp} /></dd>
          </div>
        ))}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </dl>
    </details>
  );
}

export function ReserveView({ address }: { address: string }) {
  const { safe, safes, loans } = useShell();
  const currentLoans = useLoans(address);
  const ownedChainIds = useOwnedChains();
  const [futureSetup, setFutureSetup] = useState(false);
  const hasBase = ownedChainIds ? ownedChainIds.includes(8453) : safe.networks.some((network) => network.id === "base");
  const reserve = useReserve(address, hasBase);
  if (!hasBase) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <PageHeader title="Reserve" sub="Optional. The one place the agent acts without your signature." />
        <p className="text-sm text-muted-foreground">Reserve protection works only for Aave loans on Base. This Safe is not set up on Base.</p>
      </div>
    );
  }
  if (reserve.isLoading) return <div className="p-4 md:p-6"><StateMessage kind="loading" label="Loading Reserve…" /></div>;
  if (reserve.error || !reserve.data) {
    const d = describeError(reserve.error ?? new Error("empty"), "reserve", { retry: () => void reserve.refetch(), backHref: `/s/${address}` });
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <PageHeader title="Reserve" sub="Optional. The one place the agent acts without your signature." />
        <StateMessage kind="error" title={d.title} reason={d.reason} action={d.primary} secondary={d.secondary} />
      </div>
    );
  }
  const v = reserve.data;
  if (!v.available) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <PageHeader title="Reserve" sub="Optional. The one place the agent acts without your signature." />
        <p className="text-sm text-muted-foreground">The reserve is not available on this network yet. It works on Base.</p>
      </div>
    );
  }
  // The shell's compact sidebar loan does not retain the complete debt-token list. Use the typed
  // live loan view so mixed-debt and collateral-only Aave positions cannot appear covered.
  const loanViews = currentLoans.data?.loans ?? [];
  const eligibleLoans = loanViews.filter(isReserveCoveredLoan);
  const uncoveredLoans = loanViews.filter((loan) => !isReserveCoveredLoan(loan));
  const hasCurrentLoans = loanViews.length > 0 || (!currentLoans.data && loans.length > 0);
  const coveredAaveLoan = eligibleLoans.length > 0;
  const coverage = hasCurrentLoans && (uncoveredLoans.length > 0 || (!currentLoans.data && !coveredAaveLoan))
    ? <p className="p-4 pb-0 text-sm text-muted-foreground">
      {!currentLoans.data
        ? "Loan coverage could not be confirmed. Reserve protection only covers Base Aave loans with one USDC debt and collateral. Mixed-debt and collateral-only positions are not covered."
        : <>{uncoveredLoans.map((loan) => `Your current ${lenderLabel(loan.lender)} position is not covered. ${coverageReason(loan)}. `).join("")}
          Reserve protection only covers Base Aave loans with one USDC debt and collateral. Mixed-debt and collateral-only positions are not covered.</>}
    </p>
    : null;
  const knownSafes = safes.filter((candidate) => candidate.id !== safe.id && candidate.networks.some((network) => network.id === "base" && network.deployed));
  if (!v.linked && hasCurrentLoans && !coveredAaveLoan && !futureSetup) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <PageHeader title="Reserve" sub="Optional protection for Aave loans on Base." />
        {coverage}
        <p className="text-sm text-muted-foreground">You can set this up ahead of time for an Aave loan you may take on Base. It will not protect the loan you have now.</p>
        <Button type="button" variant="outline" className="self-start" onClick={() => setFutureSetup(true)}>Set up for a future Aave loan</Button>
      </div>
    );
  }
  if (!v.linked) return <LinkForm address={address} safeName={safe.name} knownSafes={knownSafes} intro={coverage ?? (!coveredAaveLoan ? <p className="text-sm">{RESERVE_ONE_LINER}</p> : null)} />;
  return <>{coverage}<Linked onRetry={() => void reserve.refetch()} view={v} address={address} safeName={safe.name} knownSafes={knownSafes} /></>;
}

function LinkForm({ address, safeName, intro, initial, knownSafes = [] }: { address: string; safeName: string; intro?: React.ReactNode; initial?: { reserve: string; triggerHf: number; dailyLimitUsd: number }; knownSafes?: Safe[] }) {
  const [capTouched, setCapTouched] = useState(false);
  const [reserveSafe, setReserveSafe] = useState(initial?.reserve ?? "");
  const [hf, setHf] = useState(initial ? String(initial.triggerHf) : DEFAULT_HF);
  const [cap, setCap] = useState(initial ? String(initial.dailyLimitUsd) : "");
  const link = useLinkReserve(address);
  const h = parseNumber(hf);
  const c = parseNumber(cap);
  const typed = ADDRESS.test(reserveSafe.trim());
  const check = useReserveCheck(address, typed ? { chainId: CHAIN_ID, reserveSafe: reserveSafe.trim(), dailyLimitUsd: c ?? 0, triggerHf: h ?? 0 } : null);
  const balance = check.data?.balanceUsd ?? 0;
  // The same rules the server applies; the server checks again before anything is stored.
  const errs = policyErrors(hf, cap, balance);
  const showCapError = capTouched || cap.trim() !== "";
  const addressError = reserveSafe.trim() && !typed ? "This is not a valid address." : check.data?.errors.reserve;
  const selectedKnownSafe = knownSafes.some((candidate) => candidate.address.toLowerCase() === reserveSafe.trim().toLowerCase());
  const visibleAddressError = selectedKnownSafe ? addressError : null;
  const valid = typed && !errs.hf && !errs.cap && !addressError && !!check.data && !check.isFetching;
  const copy = reserveCopyV1({ triggerHf: errs.hf || h === null ? Number(DEFAULT_HF) : h, dailyLimitUsd: errs.cap || c === null ? null : c }, safeName);
  const done = link.data;
  const blocking = done ? null : !reserveSafe.trim() ? "Add a Reserve Safe address to continue." : addressError || errs.hf || (errs.cap && showCapError) ? "Fix the field marked above to continue."
    : !cap.trim() ? "Set a daily limit to continue."
    : !check.data || check.isFetching ? "Checking the Reserve Safe…" : null;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Reserve" sub="Optional. The one place the agent acts without your signature." />
      <GuideIntro topicId="reserve" />
      {intro}
      <SafeIdentity address={address} chainId={CHAIN_ID} label={`${safeName} (your Safe)`} />
      <Panel title="Reserve Safe">
        <p className="text-sm text-muted-foreground">A small second Safe holds USDC the agent can use, without asking you, to pay down your Aave loan before it is liquidated. You choose how much it can use per day.</p>
        <p className="text-sm">By default, the agent waits until your Aave loan is close to liquidation, then can use this reserve to repay part of the debt. You choose the daily limit.</p>
        <p className="text-sm text-muted-foreground">
          Before you start, the Reserve Safe needs USDC in it and the Lender agent added to it.{" "}
          <Link className="underline" href="/onboarding">Add the agent to a Safe</Link>
        </p>
        {knownSafes.length > 0 && <div className="flex flex-col gap-2"><p className="text-sm font-medium">Choose a Base Safe you own for the reserve</p><div className="flex flex-wrap gap-2">{knownSafes.map((known) => <Button key={known.id} type="button" variant={reserveSafe.toLowerCase() === known.address.toLowerCase() ? "default" : "outline"} aria-pressed={reserveSafe.toLowerCase() === known.address.toLowerCase()} onClick={() => setReserveSafe(known.address)}>{known.name}</Button>)}</div></div>}
        {!knownSafes.length && <p className="text-sm text-muted-foreground">No other Base Safe is available here. You can enter one if it is not listed.</p>}
        {reserveSafe && <p className="text-sm text-muted-foreground">{knownSafes.find((candidate) => candidate.address.toLowerCase() === reserveSafe.toLowerCase())?.name ?? "Previous Reserve Safe"} selected.</p>}
        {visibleAddressError && <p role="alert" className="text-sm text-destructive-text">{visibleAddressError}</p>}
        <Field label="Daily limit (USDC)" tone={errs.cap && showCapError ? "error" : "hint"} message={(showCapError ? errs.cap : undefined) ?? (typed && check.data ? `The Reserve Safe holds ${usd(balance)} USDC.` : "Choose the maximum amount the agent may use per day.")}>
          {(p) => <Input {...p} type="text" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => setCapTouched(true)} />}
        </Field>
        <details className="rounded-xl ring-1 ring-foreground/10">
          <summary className="cursor-pointer p-3 text-sm font-medium">Advanced setup: custom Safe address and health trigger</summary>
          <div className="grid gap-3 p-3 sm:grid-cols-2">
          <Field label="Reserve Safe address" tone={addressError ? "error" : "hint"} message={(visibleAddressError ? "This selected Safe cannot be used." : addressError) ?? (typed && check.data ? `It holds ${usd(balance)} USDC.` : "A second Safe you own.")}>
            {(p) => <Input {...p} type="text" autoComplete="off" spellCheck={false} placeholder="0x…" value={reserveSafe} onChange={(e) => setReserveSafe(e.target.value)} />}
          </Field>
          <Field label={`Exact health trigger (default ${h !== null ? String(h) : DEFAULT_HF})`} tone={errs.hf ? "error" : "hint"} message={errs.hf ?? "1.00 is liquidation. Use 1.02 to 2.00."}>
            {(p) => <Input {...p} type="text" inputMode="decimal" value={hf} onChange={(e) => setHf(e.target.value)} />}
          </Field>
          </div>
        </details>
        <details className="rounded-xl ring-1 ring-foreground/10">
          <summary className="cursor-pointer p-3 text-sm font-medium">What the agent can and cannot do</summary>
          <div className="flex flex-col gap-2 px-3 pb-3">
            <CanCannot can={copy.can} cannot={copy.cannot} />
            <p className="text-xs text-muted-foreground">{copy.enforced}</p>
            <p className="text-xs text-muted-foreground">The reserve works on Base only, for {safeName} loans on Aave. Compound v3 loans are not covered.</p>
          </div>
        </details>
        <Involved
          rows={[
            { label: "Reserve Safe (holds the USDC)", address: typed ? reserveSafe.trim() : "", showSafeApp: true },
            { label: "Your Safe (the loan it repays)", address, showSafeApp: true },
            { label: "Aave v3 pool", address: ASSET.pool },
            { label: "USDC", address: ASSET.usdc },
          ].filter((r) => r.address)}
          note="The agent's reserve key and the Roles modifier address are created when you sign, and are not known before it. You see both in the Safe transaction and here once it is signed."
        />
        {link.error && <p role="alert" className="text-sm text-destructive-text">{link.error.message}</p>}
        {done && !link.error && (
          <p role="status" className="text-sm">
            Sent to your Reserve Safe. Sign it in Safe: until then the reserve is off.
          </p>
        )}
        <ActionFooter label={<span id="link-reason" className="flex items-start gap-2 text-sm"><PenLine className="mt-0.5 size-4 shrink-0" /><span className="min-w-0">{blocking ?? "You sign these limits in the Reserve Safe. Nothing is active until they do."}</span></span>}>
          <Button
            aria-describedby="link-reason"
            type="button" disabled={!valid || link.isPending || !!done}
            onClick={() => link.mutate({ chainId: CHAIN_ID, reserveSafe: reserveSafe.trim(), dailyLimitUsd: c!, triggerHf: h! })}
          >
            {link.isPending ? "Sending…" : "Link Reserve Safe and sign"}
          </Button>
        </ActionFooter>
      </Panel>
    </div>
  );
}

function Linked({ view, address, safeName, knownSafes, onRetry }: { onRetry: () => void; view: NonNullable<ReturnType<typeof useReserve>["data"]>; address: string; safeName: string; knownSafes: Safe[] }) {
  const { status, policy, setup } = view;
  if (!status || !policy) return null;
  return <LinkedBody onRetry={onRetry} view={view} address={address} safeName={safeName} knownSafes={knownSafes} />;
}

function LinkedBody({ view, address, safeName, knownSafes, onRetry }: { onRetry: () => void; view: NonNullable<ReturnType<typeof useReserve>["data"]>; address: string; safeName: string; knownSafes: Safe[] }) {
  const { policy: p, status: st, setup, revoke } = view;
  // Fail closed: only a confirmed owner may edit; missing ownership means the owners could not be read.
  const ownersUnknown = view.viewerIsReserveOwner === undefined;
  const readOnly = view.viewerIsReserveOwner !== true;
  const policy = p!;
  const status = st!;
  const on = status.kind !== "paused";
  const [armed, setArmed] = useState(on);
  const [restoring, setRestoring] = useState(false);
  const [hf, setHf] = useState(String(policy.triggerHf));
  const [cap, setCap] = useState(String(policy.dailyLimitUsd));
  const off = useTurnReserveOff(address);
  const change = useChangeReservePolicy(address);
  const errs = policyErrors(hf, cap, status.balanceUsd);
  const turningOff = on && !armed;
  const limitChanged = parseNumber(cap) !== policy.dailyLimitUsd;
  const triggerChanged = parseNumber(hf) !== policy.triggerHf;
  const dirty = turningOff || limitChanged || triggerChanged;
  const valid = turningOff || (!errs.hf && !errs.cap);
  const pending = off.isPending || change.isPending;
  useEffect(() => setArmed(on), [on]);
  useEffect(() => {
    setHf(String(policy.triggerHf));
    setCap(String(policy.dailyLimitUsd));
  }, [policy.triggerHf, policy.dailyLimitUsd]);
  const terminalSetup = setup && ["rejected", "failed", "stale", "stopped", "replaced"].includes(setup.stage);
  const mayRestore = status.kind === "paused" && view.revocationConfirmed === true && !view.revoke && (!setup || terminalSetup) && view.viewerIsReserveOwner === true;
  if (restoring && mayRestore) return <LinkForm address={address} safeName={safeName} knownSafes={knownSafes} initial={{ reserve: policy.reserve, triggerHf: policy.triggerHf, dailyLimitUsd: policy.dailyLimitUsd }} intro={<p className="text-sm text-muted-foreground">Review the previous limits and sign fresh setup in the Reserve Safe. Protection stays off until the new setup executes.</p>} />;
  const discard = () => { setArmed(on); setHf(String(policy.triggerHf)); setCap(String(policy.dailyLimitUsd)); };
  const sign = () => {
    if (turningOff) off.mutate(8453);
    else change.mutate({ ...(limitChanged ? { dailyLimitUsd: String(parseNumber(cap)) } : {}), ...(triggerChanged ? { trigger: String(parseNumber(hf)) } : {}) });
  };
  const sent = off.data ?? change.data;
  const sendError = off.error ?? change.error;
  const pct = status.limitUsd > 0 ? Math.min(100, (status.usedUsd / status.limitUsd) * 100) : 0;
  const stuck = status.kind === "limitReached";
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Reserve" sub={`Base only · Aave loans of ${safeName}`} />
      <GuideIntro topicId="reserve" />
      <SafeIdentity address={policy.reserve} chainId={CHAIN_ID} label="Reserve Safe" />

      <div className={cn("flex items-start gap-2 rounded-xl p-3 text-sm", bannerStyle[status.tone])}>
        {status.tone === "warning" ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /> : <PiggyBank className={cn("mt-0.5 size-4 shrink-0", status.tone === "success" && "text-success")} />}
        <span>{status.banner}</span>
      </div>

      {setup && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted p-3 text-sm">
          <span>{setup.stage === "queued" || setup.stage === "sending" ? "Waiting for the Reserve Safe's owners to sign the setup." : setup.stage === "executed" ? "Signed. Reading the policy from the chain." : terminalSetup ? "The previous setup was not approved. Once the removal is confirmed, you can review and try again." : "The setup is not waiting in the Reserve Safe queue."}</span>
          <a className="inline-flex items-center gap-1 underline" href={setup.link} target="_blank" rel="noreferrer">Open in Safe <ExternalLink className="size-3.5" aria-hidden /></a>
        </div>
      )}

      {mayRestore && <div className="rounded-xl bg-muted p-3 text-sm"><p>Protection is off. The Reserve Safe has removed the agent's permission.</p><Button type="button" className="mt-2" onClick={() => setRestoring(true)}>Set up protection again</Button></div>}

      {revoke && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted p-3 text-sm">
          <span>{revoke.text}</span>
          <a className="inline-flex items-center gap-1 underline" href={revoke.link} target="_blank" rel="noreferrer">Open in Safe <ExternalLink className="size-3.5" aria-hidden /></a>
        </div>
      )}

      {!policy.asDesigned && !setup && (
        <div role="alert" className="rounded-xl bg-warning/10 p-3 text-sm ring-1 ring-warning/30">
          <p>This Reserve is not set up as designed, so the agent will not use it.</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">{policy.issues.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      )}

      <Panel guideTarget="reserve-protection" title="What the agent may do">
        <CanCannot {...policy.copy} />
        <p className="text-xs text-muted-foreground">{policy.copy.enforced}</p>
        <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); if (dirty && valid && !pending) sign(); }}>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3 text-sm sm:flex-col sm:items-start">
              <span>Agent can use reserve</span>
              <Switch checked={armed} disabled={!on || readOnly} onCheckedChange={setArmed} />
            </label>
            <Field label="Agent uses the reserve when health drops below" tone={errs.hf && !turningOff ? "error" : "hint"} message={(!turningOff && errs.hf) || `${triggerChanged ? `Signed now: ${String(policy.triggerHf)}. ` : ""}1.00 is liquidation. Use 1.02 to 2.00.`}>
              {(f) => <Input {...f} type="text" inputMode="decimal" readOnly={readOnly} disabled={!on || turningOff} value={hf} onChange={(e) => setHf(e.target.value)} />}
            </Field>
            <Field label="Daily limit" tone={errs.cap && !turningOff ? "error" : "hint"} message={(!turningOff && errs.cap) || `${limitChanged ? `Signed now: ${exactDollars(policy.dailyLimitUsd)} a day. ` : ""}The Reserve Safe holds ${usd(status.balanceUsd)}.`}>
              {(f) => <Input {...f} type="text" inputMode="decimal" readOnly={readOnly} disabled={!on || turningOff} value={cap} onChange={(e) => setCap(e.target.value)} />}
            </Field>
          </div>
          {policy.periodHours !== 24 && <p className="text-xs text-warning-text">On-chain, this limit refills every {policy.periodHours} h, not once a day.</p>}
          {sendError && <p role="alert" className="text-sm text-destructive-text">{sendError === change.error && sendError instanceof ApiError && sendError.status >= 500 ? "We could not send this change to the Reserve Safe. Your limits are unchanged. Try again." : sendError.message}</p>}
          {sent && !sendError && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted p-3 text-sm">
              <span>{"sentence" in sent ? sent.sentence : sent.summary}</span>
              <a className="inline-flex items-center gap-1 underline" href={sent.link} target="_blank" rel="noreferrer">Open in Safe <ExternalLink className="size-3.5" aria-hidden /></a>
            </div>
          )}
          {ownersUnknown && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
              <span>The owners of the Reserve Safe could not be checked, so changes are off for now.</span>
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry</Button>
            </div>
          )}
          {readOnly && !ownersUnknown && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="flex items-start gap-2"><PenLine className="mt-0.5 size-4 shrink-0" aria-hidden /><span>Only owners of the Reserve Safe can link it:</span></span>
              <ul className="flex flex-col gap-1 pl-6">{(view.reserveOwners ?? []).map((o) => <li key={o}><AddressText address={o} chainId={CHAIN_ID} /></li>)}</ul>
            </div>
          )}
          {dirty && !sent && !readOnly && (
            <ActionFooter label={<span className="flex items-start gap-2 text-sm"><PenLine className="mt-0.5 size-4 shrink-0" /><span className="min-w-0">Needs a Reserve Safe signature</span></span>}>
              <Button type="button" variant="ghost" onClick={discard}>Discard</Button>
              <Button type="submit" disabled={!valid || pending}>{pending ? "Sending…" : turningOff ? "Sign to turn off" : "Sign policy change"}</Button>
            </ActionFooter>
          )}
        </form>
      </Panel>

      <Involved
        rows={[
          { label: "Agent's reserve key", address: policy.executor },
          { label: "Reserve Safe", address: policy.reserve },
          { label: "Roles modifier", address: policy.roles },
          { label: "Aave v3 pool", address: policy.pool },
          { label: "USDC", address: policy.usdc },
        ]}
      />

      <Panel title="Used today">
        <div className="flex justify-between text-sm"><span>{usd(status.usedUsd)} of {usd(status.limitUsd)} used today</span><span className="text-muted-foreground">{usd(status.leftUsd)} left</span></div>
        <div className="h-2 rounded-full bg-muted ring-1 ring-inset ring-edge"><div className={cn("h-2 rounded-full", stuck ? "bg-warning" : "bg-foreground")} style={{ width: `${pct}%` }} /></div>
        {status.resetLabel && <span className="text-xs text-muted-foreground">{status.resetLabel}</span>}
        <span className="text-xs text-muted-foreground">The Reserve Safe holds {usd(status.balanceUsd)}.</span>
        <span className="text-xs text-muted-foreground">To top up, send USDC on Base to the Reserve Safe address at the top.</span>
      </Panel>
    </div>
  );
}
