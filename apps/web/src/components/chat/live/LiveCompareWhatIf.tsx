"use client";
import { CompareBlock } from "@/components/blocks/CompareBlock";
import { WhatIfBlock } from "@/components/blocks/WhatIfBlock";
import type { UIBlock } from "@/lib/blocks";
import { useCompareBlock, useWhatIfBlock } from "@/client/blocks";
import { AsOf, BlockLoading } from "./AsOf";
import { Button } from "@/components/ui/button";

type Props = { safeAddress: string; disabled?: boolean };

/** "Plan this" on a row posts a plan block for that lender into the chat; the figures of the compared rows stay in the block. */
export function LiveCompare({ block, safeAddress, onPostBlock, disabled }: Props & { block: Extract<UIBlock, { kind: "compare" }>; onPostBlock?: (block: UIBlock) => void }) {
  const q = useCompareBlock(safeAddress, { cash: block.cash, asset: block.asset, network: block.network });
  if (q.isPending) return <BlockLoading />;
  if (q.isError) return <p className="text-sm text-muted-foreground" role="alert">{q.error.message} <Button type="button" variant="link" size="inline" onClick={() => void q.refetch()}>Try again</Button></p>;
  const d = q.data;
  return (
    <div className="flex flex-col gap-1">
      <CompareBlock cash={d.cash} asset={d.asset} network={d.network} rows={d.rows} bestId={d.cheapest} disabled={disabled || !onPostBlock}
        onUse={(venueId) => onPostBlock?.({ kind: "plan", cash: d.cash, asset: d.asset, network: d.source, venueId })} />
      {d.unread.length > 0 && <p role="status" className="text-xs text-muted-foreground">I couldn't check {d.unread.map((n) => n.name).join(" and ")}, so this comparison may miss funds there. <Button type="button" variant="link" size="inline" onClick={() => void q.refetch()}>Try again</Button></p>}
      <AsOf readAt={d.readAt} blockNumber={d.blockNumber} />
    </div>
  );
}

export function LiveWhatIf({ block, safeAddress }: Props & { block: Extract<UIBlock, { kind: "whatif" }> }) {
  const q = useWhatIfBlock(safeAddress, { cash: block.cash, asset: block.asset, network: block.network });
  if (q.isPending) return <BlockLoading />;
  if (q.isError) return <p className="text-sm text-muted-foreground" role="alert">{q.error.message} <Button type="button" variant="link" size="inline" onClick={() => void q.refetch()}>Try again</Button></p>;
  const d = q.data;
  return (
    <div className="flex flex-col gap-1">
      <WhatIfBlock asset={d.asset} price={d.price} loans={d.loans} hypothetical={d.hypothetical} cash={d.cash} initialDrop={block.drop} capped={block.capped} />
      {d.unread.length > 0 && <p role="status" className="text-xs text-muted-foreground">I couldn't check {d.unread.map((n) => n.name).join(" and ")}, so loans there are not included. <Button type="button" variant="link" size="inline" onClick={() => void q.refetch()}>Try again</Button></p>}
      <AsOf readAt={d.readAt} blockNumber={d.blockNumber} />
    </div>
  );
}
