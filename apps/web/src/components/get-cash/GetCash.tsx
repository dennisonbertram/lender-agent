"use client";
// The Get cash planner (BP-34): one screen, the amount with the live plan under it. Every figure comes from the server: the
// amount rules from `checkAmount`, the choices from `useGetCash`, the plan from the same quote the chat
// plan card uses (so "Options" adjusts the same draft). The page computes none.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Banknote, ChevronDown, ChevronRight, Landmark, Lock, Percent, TrendingDown } from "lucide-react";
import { useGetCash } from "@/client/blocks";
import { useAgentStatus } from "@/client/agent";
import { markIfMatches, type ClickedPlan } from "@/client/approve-intent";
import { useLoans } from "@/client/loans";
import { useProposal, useProposals } from "@/client/proposals";
import { QuoteError, useQuote, useSendPlan, type QuoteInput } from "@/client/quote";
import { ProposalCardSlot } from "@/components/chat/ProposalCardSlot";
import { AddAgentAction } from "@/components/agent/AgentOffNotice";
import { ActionFooter, radioCard, useFocusOnChange } from "@/components/common";
import { safePaths } from "@/components/shell/Sidebar";
import { useSafeNickname, useShell } from "@/components/shell/ShellContext";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { SafeIdentity } from "@/components/wallet/SafeIdentity";
import { AddressText } from "@/components/ui/address";
import { NetworkMark } from "@/components/ui/network-mark";
import { StateMessage } from "@/components/ui/state-message";
import { LimitWhy } from "@/components/blocks/LimitWhy";
import { describeError } from "@/lib/errors";
import { wasNowLine, type PreviousPlan } from "@/lib/borrow-limit";
import { checkAmount, parseCash } from "@/lib/cash-amount";
import { cashDoneLine } from "@/lib/cash-plan";
import { fmt, usd } from "@/lib/format";
import { MIN_LOAN } from "@/lib/loan-math";
import { planSummary } from "@/lib/loan-copy";
import { explorerTxUrl, formatAddress } from "@/lib/explorer";
import { describe } from "@/components/proposals/review-state";
import { cn } from "@/lib/utils";
import { useWatchStatus } from "@/components/agent/AgentWatchStatus";
import { useEmailSettings } from "@/client/alerts";

const APPROVE_NOTE = "Sends this plan to your Safe, then your wallet asks for your free approval.";
const TIMES = [
  { months: 3 as const, title: "A few months", phrase: "for a few months" },
  { months: 12 as const, title: "About a year", phrase: "about a year" },
  { months: 24 as const, title: "Longer or not sure", phrase: "longer than a year" },
];
const SAFETY_WORD = ["extra safe", "balanced safety", "lean safety"];
/** One id per planning session (OC-04): the server keys the draft, and so the idempotency key, on it. A reused id would hand back the frozen draft's old proposal. */
const newSessionId = () => `get-cash-${crypto.randomUUID()}`;

/** Balance with at most two decimals: 8, 0.5, 6.12. */
const held = (n: number) => String(+n.toFixed(2));

const Row = ({ icon: Icon, children }: { icon: typeof Banknote; children: React.ReactNode }) => (
  <li className="flex items-start gap-3">
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"><Icon className="size-4" /></span>
    <span className="min-w-0 pt-1">{children}</span>
  </li>
);

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-full items-start justify-center p-4 pt-[6vh]">
    <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">{children}</div>
  </div>
);

type Sent = { proposalId: string; receipt?: string; cash: number; borrowAsset: string };

/** After Send: status only. The proposal card shows where it stands; once executed, where the money is. */
function SentView({ address, sent, onAgain }: { address: string; sent: Sent; onAgain: () => void }) {
  const { safe } = useShell();
  const { safeName } = useSafeNickname();
  const displaySafeName = safeName(safe.address, safe.name);
  const p = useProposal(address, sent.proposalId);
  const loans = useLoans(address);
  const executed = p.data?.stage === "executed";
  const focus = useFocusOnChange<HTMLHeadingElement>(executed);
  if (executed) {
    // The new loan is this proposal's own; fall back to the overview until the list has it.
    const loanListed = !!p.data?.loanId && !!loans.data?.loans.some((l) => l.id === p.data!.loanId);
    return (
      <div className="flex flex-col gap-3 text-sm" role="status">
        <h1 ref={focus} tabIndex={-1} className="text-lg font-medium outline-none">Your cash is in {displaySafeName}</h1>
        <p>{cashDoneLine(sent.cash, sent.borrowAsset, displaySafeName)}</p>
        <AddressText address={safe.address} chainId={p.data?.chainId} label="Safe" showSafeApp />
        <Button size="lg" render={<Link href={loanListed ? safePaths(address).loan(encodeURIComponent(p.data!.loanId!)) : safePaths(address).overview} />}>{loanListed ? "View loan" : "Go to overview"}</Button>
        <Button variant="ghost" onClick={onAgain}>Get more cash</Button>
      </div>
    );
  }
  // One state table decides the heading, the status line and the one action — the same words the
  // proposal page uses, so a fully approved plan never reads "waiting for signatures" here.
  const d = p.data && (p.data.state || p.data.stage === "sending") ? describe(p.data, { phase: "idle", lastSignerSends: true }) : null;
  const owners = p.data?.owners;
  // Signatures still missing (not the Safe's total threshold): a 2-of-3 Safe with one approval waits for one more.
  const needed = p.data?.stage === "queued" ? p.data.needsSignatures || (p.data.signedCount ? 0 : p.data.threshold) : 0;
  const waitingFor = owners ? owners.filter((o) => !o.signed).map((o) => (o.isYou ? "You" : formatAddress(o.address))) : [];
  const sentAt = p.data?.createdAt ? new Date(p.data.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const href = `/s/${address}/proposals/${encodeURIComponent(sent.proposalId)}`;
  const sigWait = !d || ["needs_your_signature", "needs_last", "needs_last_send", "needs_last_no_fee", "wallet_open", "wallet_closed", "saving", "smart_account", "waiting_for_others"].includes(d.id);
  const txLink = d?.id === "sending" && p.data?.pendingTxHash ? explorerTxUrl(p.data.chainId, p.data.pendingTxHash) : null;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-medium"><Link href={href} className="underline underline-offset-2">{d?.headline ?? "Next: approve it here"}</Link></h1>
      <p className="text-sm">{p.data?.stage === "sending" ? p.data.sentence : sent.receipt ?? "Sent to your Safe."}</p>
      {p.data?.stage === "sending" ? null : p.data?.stage === "queued" && sigWait && needed ? (
        <p className="text-sm" data-testid="who-signs">
          Waiting for {needed} more {needed === 1 ? "approval" : "approvals"}{waitingFor.length > 0 && <>: {waitingFor.join(", ")}</>}{sentAt && <span className="text-muted-foreground"> · sent {sentAt}</span>}
        </p>
      ) : d?.note ? <p className="text-sm">{d.note.text}</p> : d?.body ? <p className="text-sm">{d.body}</p> : sentAt ? <p className="text-sm text-muted-foreground">Sent {sentAt}</p> : null}
      {txLink && <a className="self-start text-sm underline" href={txLink} target="_blank" rel="noreferrer">View transaction</a>}
      <ProposalCardSlot safeAddress={address} proposalId={sent.proposalId} placement="page" hideTitle />
    </div>
  );
}

export function GetCash({ address }: { address: string }) {
  const { safe } = useShell();
  const watch = useWatchStatus();
  const email = useEmailSettings().query;
  const router = useRouter();
  const agentStatus = useAgentStatus(address);
  const [startAnyway, setStartAnyway] = useState(false);
  const [text, setText] = useState("");
  const [asset, setAsset] = useState<string>();
  const [hfIdx, setHfIdx] = useState<0 | 1 | 2>(1);
  const [months, setMonths] = useState<3 | 12 | 24>(12);
  const [venueId, setVenueId] = useState<string>();
  /** The plan the user had before switching lender (VC-02): the "Was" of the Was/now note. */
  const [origin, setOrigin] = useState<PreviousPlan>();
  const [dismissed, setDismissed] = useState<string>();
  const [sentInfo, setSentInfo] = useState<Pick<Sent, "cash" | "borrowAsset">>();
  const fallbackKey = useRef<string>(undefined);
  const [messageId, setMessageId] = useState(newSessionId);
  /** The funded source the user picked after the server offered a choice; undefined means the server's pick. */
  const [picked, setPicked] = useState<string>();

  const first = useGetCash(address, {});
  // The choices fetch takes the parsed amount, not the validated one: which maximum applies is decided
  // by the network the server ends up planning on, and that network's `d` arrives after this hook.
  const wanted = parseCash(text);
  const gc = useGetCash(address, { cash: wanted !== null && wanted >= MIN_LOAN ? wanted : undefined, asset, hfIdx, network: picked });
  const raw = gc.data ?? first.data;
  // While a picked source's data has not settled — still loading or the read failed — the previous plan
  // stays visible but nothing may send on it; coming back to it is an explicit owner choice (Stay on X).
  const pendingSource = !!picked && !!raw && (raw.network !== picked || gc.isError);
  const switching = pendingSource && !gc.isError;
  const d = raw;
  const selectedAgent = d && agentStatus.data?.networks.find((network) => network.chainId === d.chainId);
  // The monitor's last-check line is Safe-wide; network enablement follows the funded source selected for this quote.
  // Prefer the delegate read, which is refreshed after setup; shell network data can lag behind that confirmation.
  const quoteNetworkStatus = (() => {
    if (agentStatus.isError || (agentStatus.isSuccess && !selectedAgent)) return "could not check";
    if (selectedAgent) return selectedAgent.deployed && selectedAgent.added ? "enabled" : "not enabled";
    return !!d && safe.networks.some((n) => n.id === d.network && n.agent) ? "enabled" : "not enabled";
  })();
  const check = checkAmount(text, d?.maxCash ?? 0);
  const cash = check.ok ? check.cash : undefined;
  const send = useSendPlan(address);
  // While loading or on error this is empty and the form is never blocked.
  const loans = useLoans(address);
  const owed = (loans.data?.loans ?? []).reduce((sum, l) => sum + (l.debt?.usd ?? 0), 0);
  const openList = useProposals(address, { open: true });
  const waiting = (openList.data ?? []).filter((p) => p.stage === "queued").sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const input: QuoteInput | null = check.ok && d?.state === "ok" && cash !== undefined && d?.asset
    ? { cash, asset: d.asset, network: d.network, chainId: d.chainId, venueId: venueId ?? d.best ?? undefined, hfIdx, months, messageId, ...(venueId && { venueChosen: true }) }
    : null;
  const query = useQuote(address, input);
  const qd = query.data;
  const quote = qd?.quote;
  const sendPending = send.isPending || send.data?.stage === "sending" || !!qd?.draft.sendingId || !!qd?.draft.pendingSend;

  const drafted = qd?.draft.sentId;
  const sendId = send.data && send.data.stage !== "sending" && send.data.stage !== "not_sent" ? send.data.proposalId : undefined;
  const sentId = [sendId, drafted].find((id) => id && id !== dismissed);
  const head = useFocusOnChange<HTMLHeadingElement>(sentId);
  /** Once a send clicked in this tab is queued, open the proposal page: it starts the free approval (never Send/execute). A send answered "sending" hands off when the draft later reports it queued. A plan that was already sent when the page opened never navigates. */
  const opened = useRef<string>(undefined);
  const clicked = useRef<ClickedPlan>(undefined);
  const queuedId = send.data?.stage === "queued" ? send.data.proposalId : undefined;
  const handoffId = queuedId ?? (clicked.current ? drafted : undefined);
  useEffect(() => {
    const plan = clicked.current;
    if (!handoffId || !plan || opened.current === handoffId) return;
    opened.current = handoffId;
    void markIfMatches(address, handoffId, plan).then(() => router.push(`${safePaths(address).overview}/proposals/${handoffId}`));
  }, [handoffId, address, router]);

  const reset = () => { setDismissed(sentId); setText(""); setVenueId(undefined); setOrigin(undefined); setHfIdx(1); setAsset(undefined); setSentInfo(undefined); setPicked(undefined); send.reset(); fallbackKey.current = undefined; setMessageId(newSessionId()); };
  /** An explicit source switch re-plans on the offered network; the amount and choices carry over. */
  const switchTo = (network: string) => {
    if (sendPending) return;
    setPicked(network); setVenueId(undefined); setOrigin(undefined); send.reset();
  };
  /** A new amount clears choices that may no longer fit it. */
  const editAmount = (t: string) => { setText(t); setAsset(undefined); setVenueId(undefined); setOrigin(undefined); setHfIdx(1); };

  if (!d) {
    if (!first.error) return <Card><StateMessage kind="loading" label="Loading your Safe…" /></Card>;
    const e = describeError(first.error, "cash", { retry: () => void first.refetch(), backHref: safePaths(address).overview });
    return <Card><StateMessage kind="error" title={e.title} reason={e.reason} action={e.primary} secondary={e.secondary} className="max-w-none shadow-none ring-0 p-0" /></Card>;
  }

  if (d.state !== "ok" && !sentId) {
    // A network that could not be read is unknown, not empty: say so and offer a retry before any top-up advice.
    if (d.unread.length > 0) {
      const names = d.unread.map((u) => u.name).join(" and ");
      return (
        <Card>
          <h1 className="text-lg font-medium">I couldn't check {names} — anything held there isn't counted.</h1>
          <p className="text-xs text-muted-foreground">On {d.networkName} this Safe {d.state === "empty" ? "holds nothing to borrow against" : `doesn't hold enough to borrow ${usd(MIN_LOAN)} safely`}, but funds on {names} may already cover the loan.</p>
          <Button size="lg" onClick={() => { void first.refetch(); void gc.refetch(); }}>Try again</Button>
          <Button size="lg" variant="outline" render={<Link href={safePaths(address).overview} />}>Go to Safe home</Button>
        </Card>
      );
    }
    return (
      <Card>
        <h1 className="text-lg font-medium">{d.state === "empty" ? "Add ETH or wstETH to this Safe first." : `This Safe doesn't hold enough to borrow ${usd(MIN_LOAN)} safely.`}</h1>
        <p className="text-xs text-muted-foreground">You borrow against ETH or wstETH. Once it holds some, I can plan a loan.</p>
        {d.state === "empty" && (
          <div className="flex flex-col gap-1 rounded-lg bg-muted/40 p-3 text-sm">
            <span>Send ETH or wstETH on {d.networkName} to this address:</span>
            <AddressText address={address} chainId={d.chainId} showSafeApp />
          </div>
        )}
        {d.otherFunded.length > 0 && <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">This Safe can also borrow on {d.otherFunded.map((o) => <Button key={o.chainId} type="button" variant="link" size="inline" disabled={sendPending} onClick={() => switchTo(o.network)}><NetworkMark id={o.chainId} className="size-3.5" />Use {o.name}</Button>)}</p>}
        <Button size="lg" render={<Link href={safePaths(address).overview} />}>Go to Safe home</Button>
      </Card>
    );
  }

  if (sentId) {
    return <Card><SentView address={address} sent={{ proposalId: sentId, receipt: send.data?.receipt, cash: sentInfo?.cash ?? qd?.cash ?? 0, borrowAsset: sentInfo?.borrowAsset ?? (quote?.kind === "ok" ? quote.borrowAsset : "USDC") }} onAgain={reset} /></Card>;
  }

  const useAsset = d.asset ?? "";
  const agentStatusChecked = agentStatus.isSuccess && !agentStatus.isFetching;
  const agentReady = agentStatusChecked && selectedAgent?.deployed === true && selectedAgent.added;

  const onSend = () => {
    if (!canSend || !qd || !d || quote?.kind !== "ok") return;
    fallbackKey.current ??= crypto.randomUUID();
    clicked.current = { cash: qd.cash, asset: quote.asset, chainId: d.chainId, collateral: quote.collateral };
    setSentInfo({ cash: quote.cash, borrowAsset: quote.borrowAsset });
    send.mutate({ draftKey: qd.draft.draftKey ?? fallbackKey.current, cash: qd.cash, asset: quote.asset, network: d.network, chainId: d.chainId, venueId: qd.venueId, ...(venueId && { venueChosen: true }), hfIdx, months });
  };
  const sendError = send.error instanceof QuoteError ? ((send.error.body?.line as string | undefined) ?? send.error.message) : send.error?.message;
  // The quote must be the answer for what is on screen now (not the previous one kept while a new one loads).
  const current = !!qd && !query.isPlaceholderData && !query.isFetching;
  // The lender may cap the amount (a small wstETH holding): the owner confirms the smaller figure, which then goes into the input.
  const capped = current && quote?.kind === "ok" && cash !== undefined && Math.abs(qd.cash - cash) >= 0.005;
  const canSend = !pendingSource && !sendPending && current && !!qd?.testRun.canSend && quote?.kind === "ok" && !capped && agentReady;
  const chosen = qd?.venueId;
  /** Picking another lender keeps the first plan as the "Was" side until the user comes back to it. */
  const pickVenue = (id: string) => {
    if (quote?.kind === "ok") setOrigin((o) => o ?? { lender: quote.lender, apr: quote.apr, yearly: quote.yearly });
    setVenueId(id);
  };
  const was = quote?.kind === "ok" && origin && origin.lender !== quote.lender ? origin : undefined;

  const levelWord = SAFETY_WORD[hfIdx].replace(" safety", "");
  const optionsLabel = `Options: ${useAsset}, ${levelWord === "extra safe" ? "extra safe" : levelWord}, ${TIMES.find((t) => t.months === months)!.phrase}, ${chosen && chosen !== d.best ? "lender you picked" : "best lender"}`;
  const showPlanner = waiting.length === 0 || startAnyway || text !== "";

  return (
    <Card>
      <SafeIdentity address={address} chainId={d.chainId} />

      {switching && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Checking {d.otherFunded.find((o) => o.network === picked)?.name ?? "that network"}…</p>}
      {gc.isError && picked && (
        <p role="alert" className="text-sm text-destructive-text">
          I couldn't check {d.otherFunded.find((o) => o.network === picked)?.name ?? d.networkName}. No approval can be sent until this read succeeds. {d.network !== picked && <>The plan shown is still {d.networkName}. </>}{" "}
          <Button type="button" variant="link" size="inline" onClick={() => void gc.refetch()}>Try again</Button>{" "}
          <Button type="button" variant="link" size="inline" onClick={() => setPicked(d.network)}>Stay on {d.networkName}</Button>
        </p>
      )}
      {qd?.draft.pendingSend && !qd.draft.sendingId && <p role="status" className="text-sm text-muted-foreground">A loan plan is still being sent to this Safe. Check Activity before sending another.</p>}
      {d.unread.length > 0 && (
        <p className="text-sm text-muted-foreground">
          I couldn't check {d.unread.map((u) => u.name).join(" and ")} right now — anything held there isn't counted.{" "}
          <Button type="button" variant="link" size="inline" onClick={() => { void first.refetch(); void gc.refetch(); }}>Try again</Button>
        </p>
      )}
      {d.otherFunded.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {d.otherFunded.length === 1 ? `This Safe also holds funds on ${d.otherFunded[0].name} — up to ${usd(d.otherFunded[0].maxCash)} there.` : `This Safe also holds funds on ${d.otherFunded.map((o) => o.name).join(" and ")}.`}{" "}
          {d.otherFunded.map((o) => (
            <Button key={o.chainId} type="button" variant="link" size="inline" disabled={sendPending} onClick={() => switchTo(o.network)}><NetworkMark id={o.chainId} className="size-3.5" />Use {o.name}</Button>
          ))}
        </p>
      )}

      {waiting[0] && (
        <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3 text-sm">
          {/* The same state table the proposal page uses: a fully approved request says "Ready to send", never "waiting for signatures". */}
          <h2 className="font-medium">{waiting[0].state ? describe(waiting[0], { phase: "idle", lastSignerSends: true }).headline : "You already have a request waiting for signatures"}</h2>
          <p>{waiting[0].title}</p>
          <Button size="lg" render={<Link href={`${safePaths(address).overview}/proposals/${waiting[0].id}`} />}>Finish your open request</Button>
          {waiting.length > 1 && (
            <ul className="flex flex-col gap-1">
              {waiting.map((w) => <li key={w.id}><Link className="underline" href={`${safePaths(address).overview}/proposals/${w.id}`}>{w.title}</Link></li>)}
            </ul>
          )}
          {!showPlanner && <Button variant="link" size="inline" className="self-start" onClick={() => setStartAnyway(true)}>Start a different plan anyway</Button>}
          <p className="text-xs text-muted-foreground">Your open request stays until it is rejected. Both could be signed and run.</p>
        </div>
      )}

      {showPlanner && (
        <>
          <h1 ref={head} tabIndex={-1} className="text-lg font-medium outline-none">How much cash do you need?</h1>
          {owed > 0 && <p className="text-sm text-muted-foreground">On top of your {usd(owed)} loan.</p>}
          <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); if (canSend) onSend(); }}>
            <Field label="Cash you need" labelHidden messageClassName="min-h-8" tone={check.ok ? "hint" : check.tone} message={check.message}>
              {(p) => <Input {...p} inputMode="decimal" placeholder="Amount in dollars" autoFocus={waiting.length === 0} className="h-12 text-xl font-medium md:text-xl" value={text} onChange={(e) => editAmount(e.target.value)} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              {!check.ok && check.useMax !== undefined && <Button type="button" variant="outline" size="sm" onClick={() => editAmount(usd(check.useMax!))}>Use {usd(check.useMax)}</Button>}
              {d.chips.filter((c) => check.ok || check.useMax === undefined || c.amount !== check.useMax).map((c) => <Button key={c.label} type="button" variant="outline" size="sm" onClick={() => editAmount(usd(c.amount))}>{c.label}</Button>)}
            </div>
            <LimitWhy why={d.why} />

            {cash !== undefined && (
              <>
                {!qd && (query.error ? <p role="alert" className="text-sm text-destructive-text">{query.error.message}</p> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Working out the plan</p>)}
                {quote?.kind === "ok" && (
                  <>
                    {capped && <p role="status" className="text-sm font-medium">{qd.cash < cash ? `Only ${usd(qd.cash)} is possible with ${quote.asset}` : `This plan is for ${usd(qd.cash)} with ${quote.asset}`} <Button type="button" variant="link" size="inline" onClick={() => setText(usd(qd.cash))}>Use {usd(qd.cash)}</Button></p>}
                    {was && <p className="rounded-md border border-border px-3 py-2 text-xs">{wasNowLine(was, { lender: quote.lender, apr: quote.apr, yearly: quote.yearly })}</p>}
                    <ul className="flex flex-col gap-3 text-sm">
                      <Row icon={Banknote}>You get {usd(quote.cash)} as {quote.borrowAsset}, a digital dollar, in <AddressText address={address} chainId={d.chainId} className="align-middle" /> ({quote.network}).</Row>
                      <Row icon={TrendingDown}>{planSummary({ cash: quote.cash, venue: quote.lender, apr: quote.apr, collateral: quote.collateral, asset: quote.asset, price: quote.price, liqPrice: quote.liqPrice, dropPct: quote.dropPct, adding: quote.adding })[1]} Monitoring on {d.networkName}: {quoteNetworkStatus}. Safe status: {watch.line}. In-app alerts are available when monitoring is active. {email.isPending ? "Checking email settings." : email.isError ? "Could not check email alerts; review Settings." : email.data?.deliveryConfigured === false ? "Email delivery is not configured here." : email.data?.enabled && email.data.email ? `Email alerts are set to ${email.data.email}.` : email.data?.email ? "Email alerts are off. Turn them on in Settings to get alerts while you are away." : "Add an email address in Settings to get alerts while you are away."} Checks may be delayed or unavailable.</Row>
                      <Row icon={Lock}>You lock {fmt(quote.collateral, 2)} {quote.asset} ({usd(quote.collateralUsd)}).</Row>
                      <Row icon={Percent}>{qd?.costLine ?? `About ${usd(quote.yearly)} a year at ${quote.apr}%. The rate can change.`} With {quote.lender}, {chosen === d.best ? "the lowest rate that fits" : "the one you picked"}. {quote.feesLine}</Row>
                      {quote.move && <Row icon={Landmark}>{quote.move.line} {quote.move.reason && <span className="text-muted-foreground">{quote.move.reason}</span>}</Row>}
                    </ul>
                  </>
                )}
                {quote && quote.kind !== "ok" && <p className="text-sm">{quote.kind === "notFeasible" ? (quote.reason ?? `Your ${quote.asset} can't safely back ${usd(quote.cash)} right now. Pick another asset or safety level under "Options", or lower the amount.`) : "Loans are not available for this Safe yet."}</p>}
                {quote?.kind === "ok" && quote.alt && <p className="text-sm text-muted-foreground">{quote.alt.line} <Button type="button" variant="link" size="inline" onClick={() => pickVenue(quote.alt!.venueId)}>Use {quote.alt.venueName}</Button></p>}

                <details className="group rounded-xl ring-1 ring-foreground/10">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                    <span>{optionsLabel}</span> <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="flex flex-col gap-3 px-3 pb-3">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      Use:
                      <NativeSelect value={useAsset} onChange={(e) => { setAsset(e.target.value); setVenueId(undefined); setOrigin(undefined); }}>
                        {d.holdings.map((h) => <NativeSelectOption key={h.asset} value={h.asset}>{h.asset} · {held(h.balance)} in Safe</NativeSelectOption>)}
                      </NativeSelect>
                    </label>
                    <span className="text-xs text-muted-foreground">How careful should we be?</span>
                    <div role="radiogroup" aria-label="How careful" className="flex flex-col gap-2">
                      {d.levels.map((c) => (
                        <label key={c.idx} className={radioCard(hfIdx === c.idx, !c.feasible)}>
                          <input type="radio" className="sr-only" name="careful" checked={hfIdx === c.idx} disabled={!c.feasible} onChange={() => { setHfIdx(c.idx); setVenueId(undefined); setOrigin(undefined); }} />
                          <span className="text-sm font-medium">{c.title}</span>
                          {c.feasible ? (
                            <>
                              <span className="text-xs">Locks {fmt(c.collateral!, 2)} {useAsset} of your {held(d.balance)}.</span>
                          <span className="text-xs text-muted-foreground">{useAsset} can fall about {c.dropPct}% before trouble.</span>
                            </>
                          ) : (
                            <span className="text-xs">{c.needs !== undefined ? `Needs ${held(c.needs)} ${useAsset}, you have ${held(d.balance)}.` : `Your ${useAsset} can't fund this.`}</span>
                          )}
                        </label>
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">How long will you keep it?</span>
                    <div role="radiogroup" aria-label="How long" className="flex flex-col gap-2">
                      {TIMES.map((t) => (
                        <label key={t.months} className={radioCard(months === t.months)}>
                          <input type="radio" className="sr-only" name="time" checked={months === t.months} onChange={() => setMonths(t.months)} />
                          <span className="text-sm font-medium">{t.title}</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">There is no fixed schedule. You can repay any time. Trouble means the lender can sell some of your {useAsset} to repay the loan. Monitoring can be delayed or unavailable and may not warn you in time.</p>
                    {chosen && (
                      <>
                        <span className="text-xs text-muted-foreground">Other lenders</span>
                        <div className="flex flex-col gap-1">
                          {d.lenders.filter((r) => r.venueId !== chosen).map((r) => r.feasible ? (
                            <button key={r.venueId} type="button" onClick={() => pickVenue(r.venueId)} className="flex items-center justify-between gap-2 rounded-lg p-2 text-left text-sm hover:bg-muted/50 pointer-coarse:min-h-11">
                              <span>{r.lender} · {r.apr}% · about {usd(r.yearly ?? 0)} a year{r.adding && " · adds to your loan"}</span>
                              <span className="flex shrink-0 items-center text-muted-foreground">Use <ChevronRight className="size-4" /></span>
                            </button>
                          ) : (
                            <span key={r.venueId} className="p-2 text-sm text-muted-foreground">{r.lender} · {r.reason}</span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </details>

                <ActionFooter
                  className="-mx-5 px-5"
                  label={<>
                    {qd && <p className={cn("text-xs", qd.testRun.canSend ? "text-muted-foreground" : "text-destructive-text")}>{qd.testRun.line}</p>}
                    {quote?.kind === "ok" && <p className="text-xs text-muted-foreground">{APPROVE_NOTE}</p>}
                    {quote?.kind === "ok" && !agentReady && (
                      <div className="text-xs text-muted-foreground">
                        {agentStatus.isError ? (
                          <p role="alert">I couldn't check whether the Lender agent is set up on {d.networkName}. Try again before requesting this loan. <Button type="button" variant="link" size="inline" onClick={() => void agentStatus.refetch()}>Try again</Button></p>
                        ) : !agentStatusChecked ? (
                          <p role="status">Checking whether the Lender agent is set up on {d.networkName}…</p>
                        ) : selectedAgent?.deployed && !selectedAgent.added ? (
                          <div className="flex flex-col gap-2">
                            <p>Before requesting a loan on {d.networkName}, add the Lender agent to this Safe on {d.networkName}. This takes one free owner signature.</p>
                            <AddAgentAction safeAddress={address} only={d.chainId} onAdded={() => { void agentStatus.refetch(); void gc.refetch(); }} />
                          </div>
                        ) : (
                          <p role="alert">I couldn't confirm the Lender agent is set up on {d.networkName}. Try again before requesting this loan. <Button type="button" variant="link" size="inline" onClick={() => void agentStatus.refetch()}>Try again</Button></p>
                        )}
                      </div>
                    )}
                    {(send.isPending) && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner /> Sending to your Safe</p>}
                    {sendError && <p role="alert" className="text-xs text-destructive-text">{sendError}</p>}
                  </>}
                >
                  {quote?.kind === "ok" && <Button size="lg" type="submit" disabled={!canSend}>{quote.move ? "Approve move in your wallet (step 1 of 2)" : "Approve in your wallet"}</Button>}
                </ActionFooter>
              </>
            )}
          </form>
        </>
      )}
    </Card>
  );
}
