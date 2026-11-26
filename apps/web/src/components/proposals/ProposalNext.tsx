"use client";
// One way on from a proposal's end state, on the proposal page only (not in the chat thread).
import Link from "next/link";
import { useLoans } from "@/client/loans";
import { useProposal } from "@/client/proposals";
import { safePaths } from "@/components/shell/Sidebar";
import type { ProposalView } from "@/server/proposals/view";
import { Button } from "@/components/ui/button";

const STOPPED = new Set(["failed", "rejected", "stale", "stopped", "not_sent"]);

/** The one way on from an end state (shared by the page's primary and this link). */
export function nextLinkOf(p: ProposalView, safeAddress: string, loanListed: boolean): { text: string; href: string } | null {
  const paths = safePaths(safeAddress);
  const loanHref = p.loanId ? paths.loan(encodeURIComponent(p.loanId)) : paths.overview;
  if (p.stage === "executed") return null;
  if (p.stage === "replaced") return p.replacedBy ? { text: "See the new proposal", href: `/s/${safeAddress}/proposals/${p.replacedBy}` } : null;
  if (!STOPPED.has(p.stage) && p.state !== "out_of_date") return null;
  if (p.specKind === "open" || p.specKind === "move") return { text: "Make a new plan", href: paths.getCash };
  if ((p.specKind === "protect" || p.specKind === "close" || p.specKind === "repay") && loanListed) return { text: "Back to the loan", href: loanHref };
  if (p.specKind.startsWith("reserve-")) return { text: "Back to Reserve", href: paths.reserve };
  return { text: "Go to overview", href: paths.overview };
}

export function ProposalNext({ safeAddress, id }: { safeAddress: string; id: string }) {
  const { data: p } = useProposal(safeAddress, id);
  const { data: loans } = useLoans(safeAddress);
  if (!p) return null;
  const paths = safePaths(safeAddress);
  const loanListed = !!p.loanId && !!loans?.loans.some((l) => l.id === p.loanId);
  const loanHref = p.loanId ? paths.loan(encodeURIComponent(p.loanId)) : paths.overview;
  let link: { text: string; href: string } | null = null;
  // An executed card carries its own View loan / Go to overview (VC-05): one link on the page, not two.
  if (p.stage === "executed") return null;
  if (p.stage === "replaced") link = p.replacedBy ? { text: "See the new proposal", href: `/s/${safeAddress}/proposals/${p.replacedBy}` } : null;
  else if (STOPPED.has(p.stage)) {
    if (p.specKind === "open" || p.specKind === "move") link = { text: "Plan again", href: paths.getCash };
    else if ((p.specKind === "protect" || p.specKind === "close" || p.specKind === "repay") && loanListed) link = { text: "Back to the loan", href: loanHref };
    else if (p.specKind.startsWith("reserve-")) link = { text: "Back to Reserve", href: paths.reserve };
    else link = { text: "Go to overview", href: paths.overview };
  }
  if (!link) return null;
  return <div><Button variant="outline" render={<Link href={link.href} />}>{link.text}</Button></div>;
}
