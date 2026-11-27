"use client";
import { useEffect, useState } from "react";
import { PiggyBank } from "lucide-react";
import Link from "next/link";
import { TxHashLink } from "@/components/ui/address";
import { SafeIdentity } from "@/components/settings/SafeIdentity";
import { safeTxLink } from "@/server/safe/links";
import type { Address, ChainId, Hex } from "@/shared/types";
import { NetworkChip, PageHeader } from "@/components/common";
import { GuideIntro } from "@/components/guide/Guide";
import { useShell } from "@/components/shell/ShellContext";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableHeadRow, TableRow } from "@/components/ui/table";
import { timeLabel } from "@/lib/activity-copy";
import { StateMessage } from "@/components/ui/state-message";
import { describeError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useActivity, type ActivityView } from "@/client/activity";

export function ActivityLog() {
  const { safe } = useShell();
  const { data: activity = [], isPending, error, refetch } = useActivity(safe.address);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Activity" sub="What the agent, you and co-signers did in this Safe" />
      <GuideIntro topicId="activity" />
      <SafeIdentity safe={safe} />
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10" data-guide-target="activity-list">
        {error ? (
          <ErrorBody error={error} retry={() => void refetch()} safeAddress={safe.address} />
        ) : isPending ? (
          <StateMessage kind="loading" label="Loading activity…" className="px-3" />
        ) : activity.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">{`Nothing has happened in this Safe yet. Agent checks, proposals and signatures will show up here.`}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableHeadRow className="text-left text-xs text-muted-foreground">
                <TableHead className="hidden w-32 px-3 sm:table-cell">Time</TableHead>
                <TableHead className="hidden w-40 px-3 sm:table-cell">Actor</TableHead>
                <TableHead className="px-3">Event</TableHead>
              </TableHeadRow>
            </TableHeader>
            <TableBody>
              {activity.map((e) => {
                const networkId = e.displayChainId !== undefined ? e.displayChainId : e.txHash ? (e.txChainId === undefined ? e.chainId : e.txChainId) : e.chainId;
                return <TableRow key={e.id} className="h-auto hover:bg-transparent">
                  <TableCell className="hidden px-3 py-2.5 text-xs text-muted-foreground sm:table-cell">{timeLabel(e, now)}</TableCell>
                  <TableCell className="hidden px-3 py-2.5 align-middle sm:table-cell">
                    <ActorPill actor={e.actor} />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 whitespace-normal">
                    <div className="mb-1 sm:hidden"><ActorPill actor={e.actor} /></div>
                    {e.text}
                    {e.detail && <span className="block text-xs text-muted-foreground">{e.detail}</span>}
                    {networkId !== null && <span className="mt-1 block"><NetworkChip id={networkId} className="px-1.5 py-0" /></span>}
                    <RowLinks e={e} safe={safe.address} />
                    <span className="block text-xs text-muted-foreground sm:hidden">{timeLabel(e, now)}</span>
                  </TableCell>
                </TableRow>;
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function ErrorBody({ error, retry, safeAddress }: { error: unknown; retry: () => void; safeAddress: string }) {
  const d = describeError(error, "activity", { retry, backHref: `/s/${safeAddress}` });
  return <div className="p-3"><StateMessage kind="error" title={d.title} reason={d.reason} action={d.primary} secondary={d.secondary} /></div>;
}

function ActorPill({ actor }: { actor: string }) {
  const person = actor === "You" || actor.startsWith("Co-signer");
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center whitespace-nowrap gap-1 rounded-full px-2 text-xs", person ? "bg-foreground text-background" : actor === "Agent (reserve)" ? "text-warning-text ring-1 ring-warning/50" : "ring-1 ring-foreground/25")}>
      {actor === "Agent (reserve)" && <PiggyBank className="size-3" />}
      {actor}
    </span>
  );
}

function RowLinks({ e, safe }: { e: ActivityView; safe: string }) {
  const chain = e.chainId;
  // A proposal of another Safe (the Reserve Safe's setup) has no page here, and its Safe link is that Safe's.
  const elsewhere = !!e.proposalSafe && e.proposalSafe.toLowerCase() !== safe.toLowerCase();
  const safeTx = chain !== null && e.safeTxHash ? safeTxLink(chain as ChainId, (elsewhere ? e.proposalSafe : safe) as Address, e.safeTxHash as Hex) : null;
  const txChain = e.txChainId === undefined ? chain : e.txChainId;
  const hasTx = txChain !== null && !!e.txHash;
  const showProposal = !!e.proposalId && !elsewhere;
  if (!showProposal && !hasTx && !safeTx) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
      {hasTx && <TxHashLink chainId={txChain} hash={e.txHash!} label="Tx" />}
      {!hasTx && safeTx && <a href={safeTx} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">In Safe ↗</a>}
      {showProposal && <Link href={`/s/${safe}/proposals/${e.proposalId}`} className="text-primary underline-offset-4 hover:underline">View proposal</Link>}
    </span>
  );
}
