"use client";
import { useState } from "react";
import { AgentWatchStatus } from "@/components/agent/AgentWatchStatus";
import { Panel } from "@/components/common";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AddressText } from "@/components/ui/address";
import { formatAddress } from "@/lib/explorer";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { usd } from "@/lib/format";
import type { SigningProgress } from "@/client/agent";

export type AgentPanelProps = {
  agentAddress: string;
  /** Chain of the first network where the agent is on, for the explorer link. */
  chainId?: number;
  /** Names of the networks where the agent is on. */
  activeNetworks: string[];
  progress: SigningProgress | null;
  busy: boolean;
  error?: string | null;
  onAdd: () => void;
  onRemove: () => void | Promise<unknown>;
  /** Open loans of this Safe: the remove dialog says they stop being watched. */
  loans?: { lender: string; debtUsd: number | null }[];
};

/** One sentence per loan (up to three), else a count. */
function unwatchedLines(loans: { lender: string; debtUsd: number | null }[]): string {
  if (loans.length === 0) return "";
  if (loans.length > 3) return `Your ${loans.length} loans will no longer be watched or fixed automatically.`;
  return loans.map((l) => l.debtUsd === null
    ? `Your ${l.lender.split(" ")[0]} loan's debt value is unavailable. It will no longer be watched or fixed automatically.`
    : `Your ${usd(l.debtUsd)} ${l.lender.split(" ")[0]} loan will no longer be watched or fixed automatically.`).join(" ");
}

/** The Settings agent panel (r24). Alert levels and other settings arrive in M2. */
export function AgentPanel({ agentAddress, chainId, activeNetworks, progress, busy, error, onAdd, onRemove, loans = [] }: AgentPanelProps) {
  const [confirm, setConfirm] = useState(false);
  const on = activeNetworks.length > 0;
  return (
    <Panel title="Lender agent">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <div className="text-xs text-muted-foreground">Agent address</div>
          <AddressText address={agentAddress} chainId={chainId} className="text-xs" />
          <AgentWatchStatus className="mt-1" />
          <div className="text-xs text-muted-foreground">
            {on ? `Can suggest transactions on ${activeNetworks.join(" and ")} (Safe calls this a proposer). Cannot sign or move money.` : "Not added to this Safe."}
          </div>
        </div>
        {on ? (
          <Button variant="destructive" disabled={busy} onClick={() => setConfirm(true)}>Remove agent</Button>
        ) : (
          <Button disabled={busy} onClick={onAdd}>{busy ? <><Spinner /> Waiting for your signature</> : "Add agent to this Safe"}</Button>
        )}
      </div>
      {busy && progress && <p role="status" className="text-sm">Confirm in your wallet: {progress.network}, {progress.n} of {progress.total}.</p>}
      {error && <p role="alert" className="text-sm text-destructive-text">{error} You can try again.</p>}
      <AlertDialog open={confirm} onOpenChange={(o) => { if (!busy) setConfirm(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the Lender agent from this Safe?</AlertDialogTitle>
            <AlertDialogDescription>{`Removes ${formatAddress(agentAddress)} on ${activeNetworks.join(" and ")}. It can no longer suggest transactions, and alerts and standing rules stop. You sign a message in your wallet for each network; no other owner needs to sign and it costs no fee. Anything already waiting stays in Safe until you reject it. You can add it back any time.`}{loans.length > 0 && <strong className="mt-2 block font-medium text-foreground">{unwatchedLines(loans)}</strong>}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={(e) => {
              e.preventDefault();
              void Promise.resolve(onRemove()).then(() => setConfirm(false), () => {});
            }}>
              {busy ? <><Spinner /> Waiting for your signature</> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
