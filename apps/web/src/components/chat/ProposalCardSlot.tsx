"use client";
// Renders a stored proposal inside the chat (a `data-proposal` part) and on the proposal page.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { PROPOSAL_SENT_EVENT, useProposal } from "@/client/proposals";
import { StateMessage } from "@/components/ui/state-message";
import { describeError } from "@/lib/errors";
import { useLoans } from "@/client/loans";
import { safePaths } from "@/components/shell/Sidebar";
import { ProposalSummary } from "@/components/proposals/ProposalSummary";
import { ProposalReview } from "@/components/proposals/ProposalReview";
import { useIsOnScreen, useShowOnScreen } from "@/components/proposals/on-screen";
import { TxHashLink } from "@/components/ui/address";
import { ProposalStub, statusWord } from "@/components/proposals/ProposalStub";

export type ProposalPlacement = "page" | "dock" | "sheet" | "thread";
export type ProposalCardSlotProps = {
  safeAddress: string; proposalId: string; focused?: boolean;
  /** Where it renders (VC-07). "page" owns the full card and registers it on screen; "dock" shows a stub for it; every non-page slot collapses a finished plan. */
  placement?: ProposalPlacement;
  /** The page header already shows the title. */
  hideTitle?: boolean;
};
const FINISHED = new Set(["replaced", "stale", "rejected", "stopped", "not_sent", "failed"]);

/** "Show" on a dock stub: bring the page card into view and put focus on its first control. */
function showPageCard(proposalId: string) {
  const card = document.getElementById(`proposal-card-${proposalId}`);
  card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  card?.querySelector<HTMLElement>("a[href], button")?.focus({ preventScroll: true });
}

export function ProposalCardSlot({ safeAddress, proposalId, focused, placement = "thread", hideTitle }: ProposalCardSlotProps) {
  useShowOnScreen(placement === "page" ? proposalId : null);
  const onScreen = useIsOnScreen(proposalId);
  // Live while open: re-read on mount, on focus and every 5 s; a new send re-reads at once so an older plan becomes "Replaced".
  const { data, error, refetch } = useProposal(safeAddress, proposalId, { live: true });
  const { data: newer } = useProposal(safeAddress, data?.replacedBy ?? "", { enabled: !!data?.replacedBy });
  useEffect(() => {
    const onSent = () => void refetch();
    window.addEventListener(PROPOSAL_SENT_EVENT, onSent);
    return () => window.removeEventListener(PROPOSAL_SENT_EVENT, onSent);
  }, [refetch]);
  const { data: loans } = useLoans(safeAddress);
  const ref = useRef<HTMLDivElement>(null);
  // Once executed, the loan exists: refetch what shows loans (sidebar summary, overview, loans).
  const qc = useQueryClient();
  const executed = data?.stage === "executed";
  useEffect(() => {
    if (!executed) return;
    const a = safeAddress.toLowerCase();
    void qc.invalidateQueries({ queryKey: ["safes"] });
    void qc.invalidateQueries({ queryKey: ["loans", a] });
    void qc.invalidateQueries({ queryKey: ["blocks", a] });
    void qc.invalidateQueries({ queryKey: ["activity", a] });
  }, [executed, safeAddress, qc]);
  useEffect(() => {
    if (focused && data) ref.current?.scrollIntoView?.({ block: "center" });
  }, [focused, !!data]); // eslint-disable-line react-hooks/exhaustive-deps
  const paths = safePaths(safeAddress);
  const loanListed = !!data?.loanId && !!loans?.loans.some((l) => l.id === data.loanId);
  if (error) {
    const d = describeError(error, "proposal", { retry: () => void refetch(), backHref: paths.overview });
    return <StateMessage kind="error" title={d.title} reason={d.reason} action={d.primary} secondary={d.secondary} />;
  }
  if (!data) return <StateMessage kind="loading" label="Loading the proposal…" />;
  if (placement === "dock" && onScreen) return <ProposalStub title={data.title} status="Shown on this page" onAction={() => showPageCard(proposalId)} linkText="Show" />;
  if (placement === "page") return <div ref={ref} id={`proposal-card-${proposalId}`}><ProposalReview safeAddress={safeAddress} id={proposalId} /></div>;
  const href = `/s/${safeAddress}/proposals/${proposalId}`;
  // Over: one line (a plan that can still be sent from Safe{Wallet} keeps its summary, with its state).
  if (data.stage === "executed") {
    const tx = (data.executionTxHash ?? data.pendingTxHash) && <TxHashLink chainId={data.chainId} hash={(data.executionTxHash ?? data.pendingTxHash)!} />;
    // "$2,000 USDC is now in your Safe": the proceeds, from the server's doneLine ("Done. …").
    const proceeds = data.doneLine?.replace(/^Done\.\s*/, "").replace(/\.$/, "");
    return <ProposalStub title={data.title} status={<><span>Done</span>{proceeds && <> · {proceeds}</>}{loanListed && " · Loan open"}{tx && <> · {tx}</>}</>} href={loanListed ? paths.loan(encodeURIComponent(data.loanId!)) : paths.overview} linkText={loanListed ? "View loan" : "Go to overview"} />;
  }
  // A replaced plan with no signatures is one stub (a signed one stays a card: it must be rejected in Safe).
  const replacedStub = data.stage === "replaced" && !(data.inSafe && data.signedCount > 0);
  if (replacedStub || (FINISHED.has(data.stage) && !data.inSafe)) {
    const amount = newer?.title.match(/\$[\d,.]+[kKmM]?/)?.[0];
    const word = data.stage === "replaced" ? (amount ? `Replaced by the ${amount} plan` : "Replaced by a newer plan") : statusWord(data.stage);
    return <ProposalStub title={data.title} status={word} href={`/s/${safeAddress}/proposals/${data.replacedBy ?? proposalId}`} linkText="View" />;
  }
  return <div ref={ref}><ProposalSummary p={data} href={href} /></div>;
}
