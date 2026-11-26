"use client";
// The fix card and the risk banner with live data. `LiveFixCard` is also the chat block for `{ kind: "fix", loanId }`,
// so the alert card can link to it.
import { useFix, useFixActions, useWaitingFixes } from "@/client/fixes";
import { useShell } from "@/components/shell/ShellContext";
import { requiredSignatures, riskBanner } from "@/lib/loan-copy";
import { safePaths } from "@/components/shell/Sidebar";
import { FixCard, FixReplaced } from "./FixCard";
import { RiskBanner } from "./RiskBanner";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { StateMessage } from "@/components/ui/state-message";

export function LiveFixCard({ address, loanId, embedded }: { address: string; loanId: string; embedded?: boolean }) {
  const { safe, agentOn } = useShell();
  const q = useFix(address, loanId);
  const { pick, send } = useFixActions(address, loanId);
  if (q.isPending) return <StateMessage kind="loading" label="Loading the fix options…" />;
  if (q.isError) return <p className="text-sm text-muted-foreground" role="alert">{q.error.message}</p>;
  const { options, state, draft, safeLink } = q.data;
  const error = (pick.error ?? send.error)?.message ?? null;
  return (
    <FixCard
      embedded={embedded} options={embedded || !draft ? options : null} draft={draft} state={state} sigs={requiredSignatures(String(safe.threshold))} agentOn={agentOn}
      safeLink={safeLink ?? undefined} busy={pick.isPending || send.isPending} error={error} onPick={(o) => pick.mutate(o)} onSend={(id) => send.mutate(id)}
    />
  );
}

/**
 * The loan page's single red block (VC-03): the `role="alert"` banner sentence as its title, then the fix options
 * and the drafted fix. Without options or a draft (agent off) the banner stands alone. Renders nothing for a healthy loan.
 */
export function LoanRisk({ address, loanId, hf, atRisk }: { address: string; loanId: string; hf: number; atRisk: boolean }) {
  const q = useFix(address, loanId);
  if (!atRisk) return null;
  const fix = q.data?.state.fix ?? "none";
  const safeLink = q.data?.safeLink ?? undefined;
  if (q.data && !q.data.options && !q.data.draft) return <RiskBanner hf={hf} fix={fix} safeLink={safeLink} />;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-destructive/10 p-3 ring-1 ring-destructive/30" data-testid="loan-risk">
      <div className="flex flex-wrap items-center gap-3 text-sm text-destructive-text">
        <TriangleAlert className="size-4 shrink-0" />
        <p role="alert" className="flex min-h-7 min-w-0 flex-1 items-center">{riskBanner(hf, fix)}</p>
        {fix === "queued" && safeLink && <a href={safeLink} target="_blank" rel="noreferrer" className="underline underline-offset-2">Open in Safe</a>}
      </div>
      <LiveFixCard address={address} loanId={loanId} embedded />
    </div>
  );
}

/** Overview lines for fixes waiting in the Safe queue (r17): "{title}: {sentence} Open loan · Open in Safe". */
export function FixWaitingLines({ address }: { address: string }) {
  const q = useWaitingFixes(address);
  if (!q.data?.length) return null;
  return (
    <>
      {q.data.map((w) => (
        <p key={w.proposalId} className="text-sm text-muted-foreground" data-testid="fix-waiting">
          {w.title}: {w.sentence}{" "}
          <Link href={safePaths(address).loan(encodeURIComponent(w.loanId))} className="underline underline-offset-2">Open loan</Link>
          <span aria-hidden> · </span>
          <a href={w.link} target="_blank" rel="noreferrer" className="underline underline-offset-2">Open in Safe</a>
        </p>
      ))}
    </>
  );
}

export { FixReplaced };
