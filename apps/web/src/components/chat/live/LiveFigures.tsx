"use client";
import { useRouter } from "next/navigation";
import { blockCard } from "@/components/blocks/card";
import { ExplainBlock } from "@/components/blocks/ExplainBlock";
import { HoldingsBlock } from "@/components/blocks/HoldingsBlock";
import { StatusBlock } from "@/components/blocks/StatusBlock";
import { AddFundsBody } from "@/components/common";
import type { UIBlock } from "@/lib/blocks";
import type { Asset, Network } from "@/lib/types";
import { useAddFundsBlock, useExplainBlock, useHoldingsBlock, useStatusBlock } from "@/client/blocks";
import { AsOf, BlockError, BlockLoading } from "./AsOf";

type Props = { safeAddress: string; onSend: (text: string) => void };

export function LiveExplain({ block, safeAddress, onSend }: Props & { block: Extract<UIBlock, { kind: "explain" }> }) {
  const q = useExplainBlock(safeAddress, block.topic);
  if (q.isPending) return <BlockLoading />;
  if (q.isError) return <BlockError message={q.error.message} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-1">
      <ExplainBlock block={block} needs={d.needs} levels={d.levels} maxCash={d.maxCash} onSend={onSend} />
      {d.lenderLine && <p className="text-sm">{d.lenderLine}</p>}
      <AsOf readAt={d.readAt} blockNumber={d.blockNumber} />
    </div>
  );
}

export function LiveStatus({ safeAddress, onSend }: Props) {
  const q = useStatusBlock(safeAddress);
  const router = useRouter();
  if (q.isPending) return <BlockLoading />;
  if (q.isError) return <BlockError message={q.error.message} />;
  const d = q.data;
  const mixed = d.loans.filter((l) => l.mixed);
  return (
    <div className="flex flex-col gap-1">
      <StatusBlock loans={d.loans} maxCash={d.maxCash} onSend={onSend} onOpenLoan={(id) => router.push(`/s/${safeAddress}/loans/${encodeURIComponent(id)}`)} />
      {mixed.length > 0 && <p className="text-xs text-muted-foreground">This account holds more than one asset, so I show its health only, with no liquidation price.</p>}
      <AsOf readAt={d.readAt} blockNumber={d.blockNumber} />
    </div>
  );
}

export function LiveHoldings({ safeAddress, onSend, onPostBlock }: Props & { onPostBlock?: (block: UIBlock) => void }) {
  const q = useHoldingsBlock(safeAddress);
  if (q.isPending) return <BlockLoading />;
  if (q.isError) return <BlockError message={q.error.message} />;
  return (
    <div className="flex flex-col gap-1">
      <HoldingsBlock rows={q.data.rows} onSend={onSend} onPlan={onPostBlock && ((r, cash) => onPostBlock({ kind: "plan", cash, asset: r.asset as Asset, network: r.network as Network }))} />
      <AsOf readAt={q.data.readAt} blockNumber={q.data.blockNumber} />
    </div>
  );
}

/** M1 wording: only what the Safe can use on Base. */
export function LiveAddFunds({ safeAddress }: Pick<Props, "safeAddress">) {
  const q = useAddFundsBlock(safeAddress);
  if (q.isPending) return <BlockLoading />;
  if (q.isError) return <BlockError message={q.error.message} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-1">
      <details className={blockCard} open>
        <summary className="cursor-pointer font-medium">Add funds to this Safe</summary>
        <div className="pt-3"><AddFundsBody address={d.address} networks={d.networks} assets={d.assets} /></div>
      </details>
      <AsOf readAt={d.readAt} blockNumber={d.blockNumber} />
    </div>
  );
}
