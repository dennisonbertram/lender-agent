"use client";
// The plan block with live figures from the quote endpoint (BP-12). The block carries parameters;
// every figure comes from `/api/safes/[address]/quote` (one block number) and the Test run line from
// the same response. "Approve in your wallet" posts the draft to the proposals route (BP-14).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PlanBlock, tidyFee, type PlanQuote } from "@/components/blocks/PlanBlock";
import { usd } from "@/lib/format";
import type { UIBlock } from "@/lib/blocks";
import { MIN_LOAN, parseUsd } from "@/lib/loan-math";
import { safePaths } from "@/components/shell/Sidebar";
import { AddAgentAction } from "@/components/agent/AgentOffNotice";
import { useAgentStatus } from "@/client/agent";
import { CHAIN_NAME, NETWORK_OF } from "@/shared/types";
import { markIfMatches, type ClickedPlan } from "@/client/approve-intent";
import { servedChainOf } from "@/lib/networks";
import { useGreeting } from "@/client/blocks";
import { useProposals } from "@/client/proposals";
import { QuoteError, useQuote, useSendPlan, type QuoteInput } from "@/client/quote";

export type LivePlanBlockProps = {
  block: Extract<UIBlock, { kind: "plan" }>;
  safeAddress: string;
  messageId?: string;
  onSend: (text: string) => void;
  disabled?: boolean;
  /** A proposal card follows this message in the thread. */
  proposalFollows?: boolean;
};

/** How long the first quote may take before the block gives up with a retry. */
const QUOTE_TIMEOUT_MS = 10_000;

const parseCash = (text: string) => {
  const n = parseUsd(text) ?? Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= MIN_LOAN ? n : null;
};

export function LivePlanBlock({ block, safeAddress, messageId, onSend: say, disabled, proposalFollows }: LivePlanBlockProps) {
  const [cashText, setCashText] = useState(usd(Math.max(block.cash, MIN_LOAN)));
  const [safetyIdx, setSafetyIdx] = useState<0 | 1 | 2>(block.hfIdx ?? 1);
  const edited = useRef(false);
  const fallbackKey = useRef<string>(undefined);
  const cash = parseCash(cashText);
  // A plan with no lender starts on the lender that gave the borrow limit, so it is never capped below the figure the greeting showed (VC-02).
  const greeting = useGreeting(safeAddress);
  // Only for a plan on that limit's asset: another asset (wstETH when the limit is ETH on Morpho) may have no market there, so the server chooses.
  const suits = !block.asset || block.asset === greeting.data?.lenderAsset;
  const venueId = block.venueId ?? (suits ? greeting.data?.lenderId ?? undefined : undefined);
  const lenderPending = !block.venueId && greeting.isPending;
  // The chain the block names; a name the app does not serve gets no quote. A block without one is
  // resolved by the quote (the funded owned network) — the send then runs on the chain the quote reported.
  const namedChain = block.network ? servedChainOf(block.network) : undefined;
  const input = useMemo<QuoteInput | null>(
    () => (cash === null || lenderPending || block.refusal || namedChain === null ? null : { cash, asset: block.asset, network: block.network, ...(namedChain && { chainId: namedChain }), venueId, hfIdx: safetyIdx, months: block.months, messageId, ...(block.hypothetical && { hypothetical: true }), ...(block.venueId && { venueChosen: true }) }),
    [cash, lenderPending, block.refusal, namedChain, block.asset, block.network, venueId, block.months, safetyIdx, messageId, block.hypothetical],
  );
  const query = useQuote(safeAddress, input);
  const data = query.data;
  // The chain of the plan shown: the quote and the send both name it, so what the owner signs is what the card said.
  const chainId = namedChain ?? data?.chainId ?? null;
  const send = useSendPlan(safeAddress);
  // The agent must be a proposer on the plan's network before it can send (flow-02). Unknown status never blocks the plan.
  const agent = useAgentStatus(safeAddress);
  const planNetwork = block.network ?? (chainId !== null ? NETWORK_OF[chainId] : "base");
  const agentRow = Array.isArray(agent.data?.networks) ? agent.data.networks.find((n) => n.deployed && NETWORK_OF[n.chainId] === planNetwork) : undefined;
  const agentMissing = !!agentRow && !agentRow.added;
  // An edit (BP-24) replaces the newest open loan proposal that has not run; with none open it is an ordinary new plan.
  const open = useProposals(safeAddress, { open: true }, !!block.edit);
  const replaces = block.edit ? [...(open.data ?? [])].filter((p) => p.editable).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;

  // An edit may not be sent until the open list has loaded: without it we cannot know what it replaces.
  const listBlocked = !!block.edit && !open.isSuccess;
  const listFailed = !!block.edit && open.isError;

  // An amount above the maximum starts at the maximum, until the user edits the field.
  useEffect(() => {
    // Until the user edits the field it shows what the server quoted: capped down to the maximum, or raised to a lender's minimum.
    if (data && !edited.current && cash !== null && data.cash !== cash && data.status !== "unavailable") setCashText(usd(data.cash));
  }, [data, cash]);

  // A quote that never arrives must not spin forever (chat-02).
  const [timedOut, setTimedOut] = useState(false);
  const waiting = !data && query.isFetching;
  useEffect(() => {
    if (!waiting) { setTimedOut(false); return; }
    const t = setTimeout(() => setTimedOut(true), QUOTE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [waiting]);
  const sentResult = send.data;
  // Only a queued (or later) proposal is a receipt. "sending" is pending; "not_sent" keeps the form.
  const sentStage = sentResult?.stage;
  // The latest server state (the quote refetched after Send) wins over the mutation's own result.
  const serverSaysNotSent = !!data?.draft.notSent && !data.draft.sentId && !data.draft.sendingId;
  const sentId = data?.draft.sentId ?? (sentStage && sentStage !== "sending" && sentStage !== "not_sent" ? sentResult?.proposalId : undefined);
  const pending = !sentId && !serverSaysNotSent && (sentStage === "sending" || !!data?.draft.sendingId || !!data?.draft.pendingSend);
  const quote: PlanQuote | null | undefined = data?.quote;
  // The proposal card below repeats the figures, so the receipt shrinks to one line (and goes once the card is in the thread).
  const sentText = sentId ? "Sent to your Safe." : undefined;

  // The quote may use another amount than the field (a lender's minimum raised it): Send never uses an amount the field doesn't show.
  const amountDiffers = !!data && data.status !== "unavailable" && cash !== null && Math.abs(data.cash - cash) >= 0.005;
  // The quote must answer every input on screen now (cash, asset, lender, safety, months, chain), not the previous one kept while a new one loads.
  const current = !!data && !query.isPlaceholderData && !query.isFetching;
  const canSend = current && !!data?.testRun.canSend && quote?.kind === "ok" && chainId !== null && !amountDiffers;
  const live = data && messageId ? data.draft.live : true;
  const maxCash = data?.maxCash ?? Math.max(block.cash, MIN_LOAN);

  // One action (flow-03): once a send started by a click in this tab is queued, open the proposal page, which starts the free approval. A plan that was already sent when the card rendered never navigates.
  const router = useRouter();
  const clicked = useRef(false);
  const clickedPlan = useRef<ClickedPlan>(undefined);
  const navigatedFor = useRef<string>(undefined);
  useEffect(() => {
    if (!clicked.current || !sentId || navigatedFor.current === sentId) return;
    navigatedFor.current = sentId;
    // A shared draft key can return an older proposal with other terms: only a match gets the auto-approval mark.
    const plan = clickedPlan.current;
    void (plan ? markIfMatches(safeAddress, sentId, plan) : Promise.resolve()).then(() => router.push(`${safePaths(safeAddress).overview}/proposals/${sentId}`));
  }, [sentId, router, safeAddress]);

  const onSend = () => {
    if (!current || !data || quote?.kind !== "ok" || chainId === null) return;
    clicked.current = true;
    clickedPlan.current = { cash: data.cash, asset: quote.asset, chainId, collateral: quote.collateral };
    fallbackKey.current ??= crypto.randomUUID();
    send.mutate({ draftKey: data.draft.draftKey ?? fallbackKey.current, cash: data.cash, asset: quote.asset, chainId, venueId: data.venueId, ...(block.venueId && { venueChosen: true }), hfIdx: safetyIdx, months: block.months ?? 12, ...(block.edit && { intent: "edit" as const }), ...(replaces && { replaces: replaces.id }) });
  };
  const sendError = send.error instanceof QuoteError ? ((send.error.body?.line as string | undefined) ?? send.error.message) : send.error?.message;
  const notSentError = !pending && !sentText ? data?.draft.notSent?.error : undefined;

  // The fee is stated once, in the figures; the Test run line keeps only its verdict.
  const testLine = tidyFee(data?.testRun.line ?? "").replace(/\s*Network fee (?:about )?[^.]*\.\d*[^.]*\.?$/, "").trim();
  const footer = live && !sentText && !block.hypothetical && data && quote?.kind === "ok" ? (
    <>
      {amountDiffers && <p role="status" className="font-medium">{data.cappedNote ?? `This plan is for ${usd(data.cash)}.`}{" "}<button type="button" className="underline underline-offset-2" onClick={() => { edited.current = false; setCashText(usd(data.cash)); }}>Use {usd(data.cash)}</button></p>}
      {replaces && <p>Sending this replaces "{replaces.title}".{replaces.signedCount > 0 && " It already has signatures: signing the new one does not cancel it, so reject the old one in Safe."}</p>}
      {listFailed && <p role="alert" className="text-xs text-destructive-text">Could not check your open proposals, so this edit cannot be sent yet. Reload and try again.</p>}
      {data.costLine && <p>{tidyFee(data.costLine)}</p>}
      <p className={data.testRun.canSend ? undefined : "text-destructive-text"}>{testLine || tidyFee(data.testRun.line)}</p>
      {!data.testRun.canSend && data.testRun.reason && !data.testRun.line.includes(data.testRun.reason) && <p className="text-destructive-text">{data.testRun.reason}</p>}
      {(sendError ?? notSentError) && <p role="alert" className="text-xs text-destructive-text">{sendError ?? notSentError}</p>}
    </>
  ) : undefined;

  // A superseded plan with a proposal after it needs no "Earlier plan" strip (chat-08). A sent plan with the card after it is shown by the card alone (chat-04).
  if (proposalFollows && (sentText || !live)) return null;
  const quoteError = !data ? (query.error?.message ?? (timedOut ? "Couldn't refresh the plan." : undefined)) : undefined;

  return (
    <PlanBlock
      block={block} live={live} sent={sentText} maxCash={maxCash} networkName={chainId !== null ? CHAIN_NAME[chainId] : undefined}
      cashText={cashText} safetyIdx={safetyIdx}
      onCashText={(t) => { edited.current = true; setCashText(t); }} onSafety={setSafetyIdx}
      quote={data ? quote : null} loading={waiting && !timedOut} error={quoteError} onRetry={quoteError ? () => { setTimedOut(false); void query.refetch(); } : undefined}
      onSend={onSend} onAffordable={() => say("Plan a loan I can afford")} sendingNow={send.isPending || pending} sending={disabled || send.isPending || pending || !canSend || listBlocked}
      footer={footer}
      addAgentNetwork={agentMissing ? (planNetwork === "arbitrum" ? "Arbitrum" : "Base") : undefined}
      addAgentSlot={agentMissing ? <AddAgentAction safeAddress={safeAddress} only={agentRow?.chainId} /> : undefined}
    />
  );
}
