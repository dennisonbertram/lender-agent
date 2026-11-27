"use client";
// The proposal page body (sign-flow decision): summary, money, terms, approvals and one sticky action.
// `ReviewView` is presentational (props to markup, tested per state); `ProposalReview` wires the hooks.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount, useBalance, usePublicClient } from "wagmi";
import { formatEther } from "viem";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useLoans } from "@/client/loans";
import { useProposal } from "@/client/proposals";
import { approveIntentFresh, readApproveIntent } from "@/client/approve-intent";
import { ProposalActionError, useExecuteData, useExecuteProposal, useSignData, useSignProposal } from "@/client/proposals-sign";
import { useSignOut } from "@/client/auth/useSession";
import { describeError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { NetworkChip, PageHeader } from "@/components/common";
import { GuideIntro } from "@/components/guide/Guide";
import { networkDisplayName } from "@/components/ui/network-mark";
import { safePaths } from "@/components/shell/Sidebar";
import { nextLinkOf } from "@/components/proposals/ProposalNext";
import { WrongWallet } from "@/components/proposals/WrongWallet";
import { RejectAction } from "@/components/proposals/RejectAction";
import { describe, doneSentence, isOwner, coOwnerName, feeFromReceipt, type Descriptor, type ReviewCtx, type Secondary } from "@/components/proposals/review-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePhone } from "@/components/ui/use-phone";
import { ActionBar } from "@/components/ui/action-bar";
import { BalanceChanges } from "@/components/ui/balance-changes";
import { AddressText, TxHashLink } from "@/components/ui/address";
import { explorerTxUrl, safeAppUrl } from "@/lib/explorer";
import { Disclosure } from "@/components/ui/disclosure";
import { FactGrid } from "@/components/ui/fact-grid";
import { SignatureBar, SignerRoster, shortAddress, type RosterOwner } from "@/components/ui/signer-roster";
import { Spinner } from "@/components/ui/spinner";
import { StateMessage } from "@/components/ui/state-message";
import { StatusNote } from "@/components/ui/status-note";
import { useShowOnScreen } from "@/components/proposals/on-screen";
import type { SignData } from "@/client/proposals-sign";
import type { ProposalView } from "@/server/proposals/view";

const DOT = { warning: "bg-warning", success: "bg-success", destructive: "bg-destructive", muted: "bg-muted-foreground", working: "bg-[var(--status-working)]" } as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export type ReviewHandlers = {
  onSign: () => void;
  onApproveSend: () => void;
  onSend: () => void;
  onCopy: () => void;
  onSwitch: () => void;
  onCheckAgain?: () => void;
  onTryAgain?: () => void;
};

export type ReviewViewProps = {
  p: ProposalView;
  ctx: ReviewCtx;
  safeAddress: string;
  handlers: ReviewHandlers;
  copied?: boolean;
  shareable?: boolean;
  /** The clipboard was denied: show the link to select by hand, never "Link copied". */
  manualLink?: string | null;
  error?: string | null;
  signData?: Pick<SignData, "domainHash" | "messageHash"> | null;
  /** The decline dialog trigger (a real component in the app, absent in tests). */
  rejectSlot?: ReactNode;
  activityHref?: string;
  /** The page is about to start the owner's free approval (set by the plan card's "Approve in your wallet"). */
  autoApprove?: boolean;
  loanHref?: string;
};

function SecondaryLink({ s, p, onClick, rejectSlot, ctx, activityHref, safeAddress }: { s: Secondary; p: ProposalView; onClick: ReviewHandlers; rejectSlot?: ReactNode; ctx: ReviewCtx; activityHref?: string; safeAddress: string }) {
  const ext = "inline-flex min-h-11 items-center gap-1 underline underline-offset-2";
  const btn = "inline-flex min-h-11 items-center underline underline-offset-2";
  // The explorer page of the transaction that ran: this tab's send, else the hash the server stored.
  const hash = p.executionTxHash ?? p.pendingTxHash;
  const txUrl = ctx.txUrl ?? (hash ? explorerTxUrl(p.chainId, hash) : null);
  switch (s) {
    case "decline": return <>{rejectSlot}</>;
    case "safe": return <a className={ext} href={p.links.tx ?? p.links.queue} target="_blank" rel="noreferrer">Check in Safe{"{Wallet}"} <ExternalLink aria-hidden className="size-3" /></a>;
    case "fundedSafe": {
      const href = safeAppUrl(p.chainId, safeAddress);
      return href ? <a className={ext} href={href} target="_blank" rel="noreferrer">Open my funded Safe <ExternalLink aria-hidden className="size-3" /></a> : null;
    }
    case "rejectInSafe": return <a className={ext} href={p.links.queue} target="_blank" rel="noreferrer">Reject in Safe{"{Wallet}"} <ExternalLink aria-hidden className="size-3" /></a>;
    case "viewTx":
    case "receipt": return txUrl ? <a className={ext} href={txUrl} target="_blank" rel="noreferrer">{s === "receipt" ? "View receipt" : "View transaction"} <ExternalLink aria-hidden className="size-3" /></a> : null;
    case "onlyApprove": return <button type="button" className={btn} onClick={onClick.onSign}>Only approve (free)</button>;
    case "tryAgain": return <button type="button" className={btn} onClick={onClick.onTryAgain}>Try again</button>;
    case "checkAgain": return <button type="button" className={btn} onClick={onClick.onCheckAgain}>Check again</button>;
    case "seeChanged": return activityHref ? <Link className={btn} href={activityHref}>See what changed</Link> : null;
    case "signOut": return <button type="button" className={btn} onClick={onClick.onSwitch}>Sign out</button>;
  }
}

function primaryOf(d: Descriptor, props: ReviewViewProps) {
  const { handlers: h, copied, shareable, loanHref } = props;
  const k = d.primary;
  if (k.key === "none") return null;
  const label = k.key === "copy" ? (copied ? "Link copied" : shareable ? k.label.replace("Copy link for", "Share link with") : k.label) : k.label;
  const content = <>{k.busy && <Spinner aria-hidden role="presentation" />}{k.key === "copy" && (copied ? <Check aria-hidden /> : <Copy aria-hidden />)}{label}</>;
  const common = { size: "xl" as const, variant: k.disabled ? ("secondary" as const) : ("default" as const) };
  const click = { sign: h.onSign, approveSend: h.onApproveSend, send: h.onSend, retrySend: h.onSend, checkAgain: h.onCheckAgain, copy: h.onCopy, switch: h.onSwitch }[k.key as "sign"];
  if (k.key === "loan" || k.key === "newPlan" || k.key === "seeNew" || (k.key === "earlier" && !k.external)) {
    const href = k.key === "loan" ? loanHref : k.href;
    return href ? <Button {...common} render={<Link href={href} />}>{content}</Button> : null;
  }
  if (k.key === "earlier") return <Button {...common} render={<a href={k.href} target="_blank" rel="noreferrer" />}>{content}</Button>;
  return <Button {...common} disabled={k.disabled} aria-busy={k.busy || undefined} onClick={click}>{content}</Button>;
}

function HashRow({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-start gap-2">
        <code className="min-w-0 break-all text-xs">{value}</code>
        {copy && (
          <button type="button" aria-label={`Copy ${label}`} className="inline-flex min-h-11 shrink-0 items-center gap-1 text-xs underline underline-offset-2" onClick={async () => { try { await navigator.clipboard.writeText(value); } catch { /* blocked */ } setDone(true); setTimeout(() => setDone(false), 1500); }}>
            {done ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
          </button>
        )}
      </span>
    </div>
  );
}

export function ReviewView(props: ReviewViewProps) {
  const { p, ctx, safeAddress, signData, error, rejectSlot } = props;
  const d = describe(p, ctx);
  const owners: RosterOwner[] = (p.owners ?? []).map((o) => ({ address: o.address, isYou: o.isYou, status: o.signed ? "approved" : o.isYou && ctx.phase === "saving" ? "saving" : "not_yet" }));
  const wrong = d.id === "wrong_wallet";
  const facts = p.facts;
  const t = p.threshold ?? p.signedCount;
  const k = owners.filter((o) => o.status === "approved").length;
  const live = p.stage === "queued" && owners.length > 0;
  // A signer checks the full hash against the wallet screen, so it stays on the page instead of behind a click.
  const showHash = !!p.canSign;
  const lender = facts?.terms.find((x) => x.label === "Lender")?.value;
  // L5: through the wallet sub-states the bar keeps the tallest height it had, so the page does not jump.
  const phone = usePhone(); // the compact phone bar changes height by a line at most; holding a first, unfolded height would leave a gap
  const barRef = useRef<HTMLElement>(null);
  const held = useRef(0);
  const sub = ["needs_your_signature", "wallet_open", "saving", "wallet_closed"].includes(d.id);
  const [minH, setMinH] = useState(0);
  useLayoutEffect(() => {
    if (!sub) { held.current = 0; if (minH) setMinH(0); return; }
    const h = Math.ceil(barRef.current?.getBoundingClientRect().height ?? 0);
    if (h > held.current) { held.current = h; setMinH(h); }
  });
  const done = d.id === "executed";
  const doneText = done ? doneSentence(p) : null;
  const rows = done && facts ? facts.changes.map((c) => ({ ...c, label: c.label.replace("You receive", "You received").replace("You lock up", "You locked") })) : facts?.changes;
  const note = error ? { tone: "bad" as const, text: error } : props.autoApprove && d.id === "needs_your_signature" ? { tone: "info" as const, text: "Approve in your wallet: check that the code matches before you sign." } : d.note;
  return (
    <div data-state={d.id} className={"mx-auto flex w-full max-w-[640px] flex-col"}>
      <div className="flex flex-col gap-3 p-4 pb-6">
        {wrong ? (
          <PageHeader title={d.headline} sub={d.body} />
        ) : (
          <PageHeader
            title={p.title}
            sub={`${lender ? `${lender} · ` : ""}Planned by the Lender agent · ${when(p.createdAt)}`}
            right={d.pill ? <Badge variant="outline"><span aria-hidden className={cn("size-1.5 rounded-full", DOT[d.tone])} />{d.pill}</Badge> : undefined}
          />
        )}
        <GuideIntro topicId="proposal" />
        {!wrong && (
          <p data-testid="safe-identity" className="flex flex-wrap items-center gap-x-1 text-sm">
            <AddressText label="Safe" address={safeAddress} chainId={p.chainId} showSafeApp />
            <span aria-hidden="true" className="text-muted-foreground">·</span>
            <NetworkChip id={p.chainId} className="px-1.5 py-0" />
          </p>
        )}
        {!wrong && live && (
          <section aria-label="Approvals" className="flex flex-col gap-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <div>
              <h2 className="text-sm font-semibold">{k} of {t} approved</h2>
              <p className="text-xs text-muted-foreground">{t === 1 ? (owners.length === 1 ? "You're the only owner, so your approval is all it needs." : "Your approval is enough. Any one owner can approve and send.") : owners.length === t ? "Both owners of this Safe must approve, then someone presses Send." : `Any ${t} of the ${owners.length} owners must approve, then someone presses Send.`}</p>
            </div>
            <SignatureBar threshold={t} lit={k} />
            <SignerRoster owners={owners} chainId={p.chainId} />
          </section>
        )}
        {!wrong && !live && (p.approvals?.length || p.executionTxHash) && (
          <section aria-label="Who approved" className="flex flex-col gap-1.5 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10">
            {p.approvals && p.approvals.length > 0 && (
              <div data-testid="approved-by" className="flex flex-col gap-1">
                <span className="font-medium">Approved by</span>
                <ul className="flex flex-col gap-0.5">
                  {[...p.approvals].sort((a, b) => Number(b.isYou) - Number(a.isYou)).map((a) => (
                    <li key={a.address} className="flex flex-wrap items-center gap-x-1.5">
                      <span>{a.isYou ? "You" : "Co-owner"}</span>
                      <AddressText address={a.address} chainId={p.chainId} className="text-xs text-muted-foreground" />
                      {a.at && <span className="text-xs text-muted-foreground">· {when(a.at)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {p.executionTxHash && (
              <p className="flex flex-wrap items-center gap-x-1"><TxHashLink chainId={p.chainId} hash={p.executionTxHash} label="Transaction" />{p.executedAt && <span className="text-xs text-muted-foreground">· {when(p.executedAt)}</span>}</p>
            )}
          </section>
        )}
        {!wrong && (
          <section aria-label="What happens" className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10" data-guide-target="proposal-review">
            {/* The receive/lock rows state the plan; the sentence stays only when there are no rows. */}
            {doneText ? <p className="text-sm">{doneText}</p> : !(rows && rows.length > 0) && <p className="text-sm">{facts?.sentence ?? p.outcome}</p>}
            {rows && rows.length > 0 && <BalanceChanges rows={rows} />}
            {facts && facts.terms.length > 0 && <FactGrid facts={facts.terms} />}
            {facts?.healthLine && !done && <p className="text-sm"><span className="font-medium">Loan health after: </span>{facts.healthLine}</p>}
            {!!p.safety && <p className="text-sm"><span className="font-medium">Safety: </span>{p.safety}</p>}
            {p.testRunLine && <p className="text-xs text-muted-foreground">{p.testRunLine}</p>}
            {showHash && p.safeTxHash && <HashRow label="Safe transaction hash" value={p.safeTxHash} copy />}
            <div className="-mb-2">
              <Disclosure summary="Steps in this transaction">
                <ol className="flex list-decimal flex-col gap-1 pl-4">{p.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                {p.calls && p.calls.length > 0 ? (
                  <div data-testid="calls" className="pt-2">
                    <h3 className="text-xs font-medium">Contracts this calls</h3>
                    <ul className="flex flex-col gap-1.5 pt-1">
                      {p.calls.map((c, i) => {
                        // The signed outer call of a batch is a delegatecall; only the known MultiSendCallOnly is expected.
                        const knownBatch = !!c.outer && c.delegate && c.name === "MultiSendCallOnly";
                        const warn = !c.name || (c.delegate && !knownBatch) || !!c.unreadable;
                        const notes = [c.fn && !c.outer ? `Calls ${c.fn}` : null, c.value !== "0" ? `Sends ${formatEther(BigInt(c.value))} ETH` : null, knownBatch ? "Delegatecall, runs as your Safe" : c.delegate ? "Runs as your Safe (delegatecall)" : null].filter(Boolean).join(" · ");
                        return (
                          <li key={i} className={cn("flex flex-col gap-0.5 text-xs", warn && "rounded-md bg-warning/10 p-1.5 text-warning-text", !c.outer && p.calls!.some((x) => x.outer) && "ml-3")}>
                            {c.name ? <span className="font-medium">{c.name}</span> : <span className="font-medium">Unknown contract</span>}
                            <AddressText address={c.to} chainId={p.chainId} />
                            <span className="text-muted-foreground">{notes}</span>
                            {c.unreadable && <span className="font-medium">Could not read the batch contents. Do not sign unless you trust this transaction.</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : p.target && <p className="pt-2 text-xs"><AddressText label="Calls contract" address={p.target} chainId={p.chainId} /></p>}
              </Disclosure>
              <Disclosure summary="Technical details">
                <div className="flex flex-col">
                  <HashRow label="Safe address" value={safeAddress} />
                  <HashRow label="Network" value={`${networkDisplayName(p.chainId)} (${p.chainId})`} />
                  {p.nonce !== null && <HashRow label="Order number (nonce)" value={p.nonce} />}
                  {!showHash && p.safeTxHash && <HashRow label="Safe transaction hash" value={p.safeTxHash} copy />}
                  {signData && <HashRow label="Domain hash" value={signData.domainHash} />}
                  {signData && <HashRow label="Message hash" value={signData.messageHash} />}
                  <p className="pt-1 text-xs text-muted-foreground">Check these on your wallet screen.</p>
                </div>
              </Disclosure>
            </div>
          </section>
        )}
      </div>
      <ActionBar
        barRef={barRef}
        style={sub && minH && !phone ? { minHeight: minH } : undefined}
        headline={d.headline}
        body={wrong ? undefined : d.body}
        note={<>
          {note && <StatusNote tone={note.tone}>{note.text}</StatusNote>}
          {props.manualLink && (
            <StatusNote tone="info">
              <span className="flex flex-col gap-1">
                <span>Copying is blocked in this browser. Select this link and copy it yourself:</span>
                <input readOnly value={props.manualLink} aria-label="Proposal link" onFocus={(e) => e.currentTarget.select()} className="w-full rounded bg-card px-2 py-1 text-xs" />
              </span>
            </StatusNote>
          )}
        </>}
        detail={!error && d.note?.short ? { label: "What to check in your wallet", content: <StatusNote tone={d.note.tone}>{d.note.text}</StatusNote> } : undefined}
        primary={primaryOf(d, props)}
        helper={d.helper}
        secondary={d.secondary.map((s) => <SecondaryLink key={s} s={s} p={p} ctx={ctx} onClick={props.handlers} rejectSlot={rejectSlot} activityHref={props.activityHref} safeAddress={safeAddress} />)}
      />
    </div>
  );
}

const explorerTx = (chainId: number, hash: string) => explorerTxUrl(chainId, hash) ?? undefined;
const approvedKey = (id: string) => `la:approvedAt:${id}`;
/** When this browser saw the viewer approve, "2:31 pm". The server keeps no approval time, so a fresh browser has none and the sentence is left out. */
const approvedAtOf = (id: string) => { try { return localStorage.getItem(approvedKey(id)) ?? undefined; } catch { return undefined; } };
const rememberApproved = (id: string) => { try { if (!localStorage.getItem(approvedKey(id))) localStorage.setItem(approvedKey(id), new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase()); } catch { /* storage blocked */ } };

const feeText = (usd: number | null | undefined) => (usd == null ? null : usd < 0.01 ? "under $0.01" : `about $${usd.toFixed(2)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The Safe layout shows "You are not an owner of this Safe" for a non-owner; no proposal data is fetched then.
/** `acceptApproveIntent`: only the proposal page itself starts the approval a plan card asked for; an embedded review (Get cash, chat) leaves the mark for it. */
export function ProposalReview({ safeAddress, id, acceptApproveIntent = false }: { safeAddress: string; id: string; acceptApproveIntent?: boolean }) {
  // A link by 0x safeTxHash: the read resolves it; every later call (sign, send, reject) uses the app id it returns.
  const byHash = /^0x[0-9a-fA-F]{64}$/.test(id);
  const resolved = useProposal(safeAddress, id, { enabled: byHash });
  return <ProposalReviewById safeAddress={safeAddress} id={byHash && resolved.data ? resolved.data.id : id} acceptApproveIntent={acceptApproveIntent} />;
}

function ProposalReviewById({ safeAddress, id, acceptApproveIntent }: { safeAddress: string; id: string; acceptApproveIntent: boolean }) {
  useShowOnScreen(id);
  const [phase, setPhase] = useState<"idle" | "walletOpen" | "walletClosed" | "saving">("idle");
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [shareable, setShareable] = useState(false);
  const [local, setLocal] = useState<{ error: string | null; wouldFail: string | null; feeShort: boolean }>({ error: null, wouldFail: null, feeShort: false });
  // An automatic start may only reach the wallet while this page is mounted on the same proposal (set only for that start).
  const mounted = useRef(true);
  const currentId = useRef(id);
  currentId.current = id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const autoGuard = useRef<(() => boolean) | null>(null);
  const sign = useSignProposal(safeAddress, id, {
    onWalletSigned: () => { setPhase("saving"); rememberApproved(id); },
    beforeWallet: () => (autoGuard.current ? autoGuard.current() : true),
  });
  const sentHere = useRef(false);
  const sentHashRef = useRef<string | null>(null);
  const [sent, setSent] = useState<{ hash: string; from: string | undefined; at: number } | null>(null);
  const exec = useExecuteProposal(safeAddress, id, { onSubmitted: (hash) => { sentHere.current = true; sentHashRef.current = hash; setSent({ hash, from: undefined, at: Date.now() }); } });
  const busy = sign.isPending || exec.isPending;
  const { data: p, error, refetch } = useProposal(safeAddress, id, { fast: busy });
  const { data: loans } = useLoans(safeAddress);
  const signOut = useSignOut();
  const search = useSearchParams();
  const { address: wallet } = useAccount();
  const owner = !!p && isOwner(p);
  const sendable = !!p && (p.stage === "queued" || p.state === "failed") && p.canSend === true && !p.hashMismatch;
  // Sending lasts from the wallet submit until the server reports executed/failed (or 3 minutes pass).
  const sentFrom = useRef<string | undefined>(undefined);
  sentFrom.current = sent ? sentFrom.current ?? p?.state ?? undefined : undefined;
  useEffect(() => {
    if (!sent || !p) return;
    if (p.state === "executed" || (p.state === "failed" && sentFrom.current !== "failed")) setSent(null);
    else { const t = setTimeout(() => setSent(null), Math.max(0, 180_000 - (Date.now() - sent.at))); return () => clearTimeout(t); }
  }, [sent, p]);
  const lastFee = useRef<string | null>(null);
  const ed = useExecuteData(safeAddress, id, sendable);
  const sd = useSignData(safeAddress, id, owner && p?.stage === "queued");
  if (ed.data?.fee?.usd != null) lastFee.current = feeText(ed.data.fee.usd);
  const bal = useBalance({ address: wallet, chainId: p?.chainId, query: { enabled: sendable && process.env.NEXT_PUBLIC_MOCK_WALLET !== "1" } });
  // The real fee: gasUsed × effectiveGasPrice from the receipt of the transaction this tab sent. Dollars use the ETH price implied by the estimate.
  const client = usePublicClient({ chainId: p?.chainId });
  const [receiptFee, setReceiptFee] = useState<{ text: string } | null>(null);
  const ethUsd = ed.data?.fee?.usd != null && Number(ed.data.fee.eth) > 0 ? ed.data.fee.usd / Number(ed.data.fee.eth) : null;
  const sentHash = sentHashRef.current;
  const executedNow = p?.state === "executed" || p?.state === "failed";
  useEffect(() => {
    if (!sentHash || !executedNow || !client || receiptFee?.text) return;
    let live = true;
    client.getTransactionReceipt({ hash: sentHash as `0x${string}` }).then((r) => { if (live) setReceiptFee({ text: feeFromReceipt(r, ethUsd) }); }).catch(() => { /* keep the estimate */ });
    return () => { live = false; };
  }, [sentHash, executedNow, client, receiptFee?.text, ethUsd]);
  useEffect(() => { setShareable(typeof navigator !== "undefined" && typeof navigator.share === "function" && window.matchMedia?.("(pointer: coarse)").matches); }, []);
  // After the server answers the proposal moves on: drop the "saving" sub-state.
  const signedByYou = !!p?.viewerSigned;
  useEffect(() => { if (signedByYou && phase !== "idle" && !sign.isPending) setPhase("idle"); }, [signedByYou, phase, sign.isPending]);

  // One-click approval (flow-03): a plan card send from this tab leaves a mark; once everything a manual click needs holds, start the same free approval. Never Send/execute.
  const intentFor = useRef<string | null>(null);
  const intentAt = useRef<number | null>(null);
  const [intent, setIntent] = useState(false);
  const autoStarted = useRef(false);
  const [started, setStarted] = useState(false);
  const autoSignRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (intentFor.current === id) return;
    intentFor.current = id;
    const at = acceptApproveIntent ? readApproveIntent(id) : null;
    if (at !== null) { intentAt.current = at; setIntent(true); }
  }, [id, acceptApproveIntent]);
  const ownerAddr = p?.owners?.find((o) => o.isYou)?.address;
  const lastAndSends = !!p && p.signedCount === (p.threshold ?? 2) - 1 && p.signedCount > 0 && p.canSend === true;
  const canAutoApprove = !!p && p.stage === "queued" && p.state === "needs_your_signature" && owner && !p.viewerSigned && !p.hashMismatch && !lastAndSends
    && !!sd.data && sd.data.canSign && !sd.data.reasons.some((r) => r.blocksSigning)
    && !!wallet && !!ownerAddr && wallet.toLowerCase() === ownerAddr.toLowerCase();
  useEffect(() => {
    if (!intent || autoStarted.current || !canAutoApprove || busy) return;
    // The mark only lasts two minutes: judge it now, not at mount (a wallet may connect much later).
    if (intentAt.current === null || !approveIntentFresh(intentAt.current)) { intentAt.current = null; setIntent(false); return; }
    autoStarted.current = true;
    setStarted(true);
    const startedFor = id;
    autoGuard.current = () => mounted.current && currentId.current === startedFor && intentAt.current !== null && approveIntentFresh(intentAt.current);
    autoSignRef.current();
  });
  const paths = safePaths(safeAddress);
  // Mock world only: `?demo=` forces a sub-state the walkthrough can't hold still (wallet open, saving, no fee ETH, would fail, smart account).
  const demo = process.env.NEXT_PUBLIC_MOCK_WALLET === "1" ? new URLSearchParams(search?.toString() ?? "").get("demo") : null;
  const loanListed = !!p?.loanId && !!loans?.loans.some((l) => l.id === p.loanId);
  if (error) {
    const e = describeError(error, "proposal", { retry: () => void refetch(), backHref: paths.overview });
    if (e.kind === "no-access") {
      return <WrongWallet returnTo={typeof window === "undefined" ? undefined : window.location.pathname} />;
    }
    return <StateMessage kind="error" title={e.title} reason={e.reason} action={e.primary} secondary={e.secondary} />;
  }
  if (!p) return <StateMessage kind="loading" label="Loading the plan…" />;

  const wouldFail = ed.data && !ed.data.ready && ed.data.needs === "simulation_failed" ? ed.data.reason ?? "It would fail if sent now" : local.wouldFail;
  const ctx: ReviewCtx = {
    phase: sign.isPending || exec.isPending ? (phase === "saving" ? "saving" : "walletOpen") : phase === "idle" && sign.error?.kind === "wallet_rejected" ? "walletClosed" : phase,
    lastSignerSends: true,
    fee: feeText(ed.data?.fee?.usd),
    sending: !!sent,
    txUrl: sent ? explorerTx(p.chainId, sent.hash) : undefined,
    feePaid: receiptFee?.text,
    feeEstimate: lastFee.current ?? undefined,
    retryable: p.state === "failed" && !ed.isError && !ed.isFetching && !!ed.data?.ready,
    approvedAt: p.viewerSigned ? approvedAtOf(id) : undefined,
    noFeeEth: !!bal.data && bal.data.value === 0n,
    feeShort: local.feeShort,
    precheckReady: ed.isError ? false : ed.data?.ready === true,
    precheckBusy: ed.isFetching,
    precheckError: ed.isError ? "We couldn't check this proposal right now." : ed.data?.reason,
    wouldFail,
    wrongWallet: false,
    sendBusy: exec.isPending,
    ...(demo === "wallet_open" ? { phase: "walletOpen" as const } : demo === "saving" ? { phase: "saving" as const } : demo === "wallet_closed" ? { phase: "walletClosed" as const } : demo === "smart_account" ? { smartAccount: true, fee: "about $0.02" } : demo === "no_fee_eth" ? { noFeeEth: true } : demo === "would_fail" ? { wouldFail: "Morpho refused the loan: ETH's price moved" } : {}),
    safe: shortAddress(safeAddress),
    sender: p.stage === "executed" || p.state === "failed" ? (sentHere.current ? "you" : "the sender") : undefined,
    loanListed,
    next: nextLinkOf(p, safeAddress, loanListed) ?? { text: "Make a new plan", href: paths.getCash },
  };
  const run = async (fn: () => Promise<unknown>) => {
    setLocal({ error: null, wouldFail: null, feeShort: false });
    setPhase("walletOpen");
    try { await fn(); setPhase("idle"); } catch (e) {
      const a = e instanceof ProposalActionError ? e : null;
      if (a?.kind === "cancelled") setPhase("idle");
      else if (a?.kind === "wallet_rejected") setPhase("walletClosed");
      else { setPhase("idle"); if (a?.kind === "simulation_failed") setLocal({ error: null, wouldFail: a.message, feeShort: false }); else if (a?.kind === "insufficient_funds") setLocal({ error: null, wouldFail: null, feeShort: true }); else setLocal({ error: a?.message ?? "Something went wrong. Try again.", wouldFail: null, feeShort: false }); }
    }
  };
  const handlers: ReviewHandlers = {
    onSign: () => { autoGuard.current = null; void run(() => sign.mutateAsync()); },
    onApproveSend: () => void run(() => exec.mutateAsync()),
    onSend: () => void run(() => exec.mutateAsync()),
    onCopy: async () => {
      const url = new URL(`${paths.overview}/proposals/${encodeURIComponent(id)}`, window.location.origin).toString();
      const who = coOwnerName(p);
      if (shareable) { try { await navigator.share({ title: p.title, text: `Please review and approve this plan for ${who}`, url }); setManualLink(null); return; } catch { /* cancelled: fall back to copy */ } }
      // "Link copied" only after the clipboard took it; a denied clipboard shows the link to select by hand.
      try {
        await navigator.clipboard.writeText(url);
        setManualLink(null);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setManualLink(url);
      }
    },
    onSwitch: () => void signOut(),
    onCheckAgain: async () => {
      setLocal((old) => ({ ...old, error: null }));
      try {
        const result = await ed.refetch();
        if (result.isError) {
          setLocal((old) => ({ ...old, error: "We couldn't check the latest proposal state. Try again before sending." }));
        } else if (result.data?.ready) {
          setLocal({ error: null, wouldFail: null, feeShort: false });
        } else {
          setLocal({ error: null, wouldFail: result.data?.needs === "simulation_failed" ? result.data.reason ?? "It would fail if sent now" : null, feeShort: false });
        }
      } catch {
        setLocal((old) => ({ ...old, error: "We couldn't check the latest proposal state. Try again before sending." }));
      }
    },
    onTryAgain: () => { setPhase("idle"); setLocal({ error: null, wouldFail: null, feeShort: false }); },
  };
  autoSignRef.current = () => void run(() => sign.mutateAsync());
  return (
    <ReviewView
      autoApprove={intent && !started}
      p={p} ctx={ctx} safeAddress={safeAddress} handlers={handlers} copied={copied} shareable={shareable} manualLink={manualLink}
      error={local.error} signData={sd.data ?? null} activityHref={paths.activity} loanHref={loanListed ? paths.loan(encodeURIComponent(p.loanId!)) : paths.overview}
      rejectSlot={owner && (p.state === "needs_your_signature" || p.state === "waiting_for_others" || p.state === "blocked") ? <RejectAction safeAddress={safeAddress} proposalId={id} title={p.title} approvals={p.signedCount} queueHref={p.links.queue} /> : undefined}
    />
  );
}
