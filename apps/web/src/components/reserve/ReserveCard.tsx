// The reserve card in chat (BP-41, r20): what the reserve did without a signature, why, health before and after,
// and what is left. Every figure was composed on the server from chain reads (G1).
import { Landmark } from "lucide-react";
import { blockCard } from "@/components/blocks/card";
import { cn } from "@/lib/utils";

export type ReserveCardData = { runId: number; what: string; why: string; hfBefore: number; hfAfter: number; left: string; note?: string; draftId?: string };

export function ReserveCard({ data: d }: { data: ReserveCardData }) {
  const acted = d.runId > 0;
  return (
    <div className={cn(blockCard, "gap-1.5")} data-testid="reserve-card">
      <div className="flex items-start gap-2 font-medium">
        <Landmark className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1">{d.what}</span>
      </div>
      <p className="text-sm">{d.why}{acted && " Done without your signature."}</p>
      {acted && <p className="text-sm">Health {d.hfBefore.toFixed(2)} → {d.hfAfter.toFixed(2)}.</p>}
      <p className="text-xs text-muted-foreground">{d.left}</p>
      {d.note && <p className="text-xs text-muted-foreground">{d.note}</p>}
    </div>
  );
}
