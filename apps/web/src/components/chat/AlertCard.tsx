"use client";
// The alert in chat (BP-20, r15, VC-01, VC-03, VC-08): what moved, what the owner can do, and the state of
// the card against the live loan. Wording is the mockup's (`src/components/ChatCards.tsx`). The server
// computes every figure and the state; this only lays them out.
import { ShieldAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useAlert } from "@/client/alerts";
import { useFix, useFixActions } from "@/client/fixes";
import { blockCard } from "@/components/blocks/card";
import { LiveFixCard } from "@/components/fixes/LiveFix";
import { FixOptionRow, focusFirstOption } from "@/components/fixes/FixOptionRow";
import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/ui/state-message";
import { UseReserveNow } from "@/components/reserve/UseReserveNow";
import { needsSignatures, riskHeadline } from "@/lib/loan-copy";
import { cn } from "@/lib/utils";
import type { AlertView } from "@/server/alerts/view";

export type AlertCardProps = {
  alert: AlertView;
  /** Pick an option: the fix flow (BP-22) drafts it. Options are disabled without it. */
  onChoose?: (alertId: number, option: "coll" | "repay" | "both") => void;
  /** On the overview or the alert's own loan page the options show at once; elsewhere they are collapsed (VC-03). */
  onTopic?: boolean;
  /** Set in the app: the reserve option (BP-42) shows last when a Reserve Safe is linked. */
  safeAddress?: string;
  /** The option of the current draft: shown pressed, with "Choose another" (VC-03). */
  chosen?: "coll" | "repay" | "both" | null;
};

export function AlertCard({ alert: a, onChoose, onTopic = true, safeAddress, chosen = null }: AlertCardProps) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // The stored note ends "Afterwards X could fall N% before liquidation", which is false once the loan can be liquidated now (VC-03).
  const note = a.note && a.liquidatable
    ? [a.note.replace(/\s*Afterwards .*$/, ""), riskHeadline({ status: "liquidatable", maxDrop: 0, collateral: a.asset ? [{ asset: a.asset }] : [] })].filter(Boolean).join(" ")
    : a.note;
  const venue = a.title.replace(/ loan .*$/, "");
  const reserveEligible = a.reserveEligibility.eligible;
  if (a.state !== "live") {
    const quiet = a.state === "replaced" || a.state === "resolved" || a.state === "closed";
    return (
      <div className={cn(blockCard, "gap-2", quiet && "opacity-60")}>
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium">{venue} alert at health factor {a.hf.toFixed(2)}</span>
          {a.tag && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">{a.tag}</span>}
        </div>
        {a.rule && <p className="text-xs text-muted-foreground">{a.rule.line}</p>}
        {(a.state === "resolved" || a.state === "outdated" || a.state === "fixing") && a.liveHf !== null && <p className="text-xs text-muted-foreground">Health factor is now {a.liveHf.toFixed(2)}.</p>}
      </div>
    );
  }
  if (!onTopic && !open) {
    return (
      <div className={cn(blockCard, "flex-row items-center gap-2 bg-destructive/10 ring-1 ring-destructive/30")}>
        <ShieldAlert className="size-4 shrink-0 text-destructive-text" />
        <span className="min-w-0 flex-1 font-medium text-destructive-text">{a.title}</span>
        <Button variant="ghost" size="xs" onClick={() => setOpen(true)}>Show options</Button>
      </div>
    );
  }
  return (
    <div className={cn(blockCard, "bg-destructive/10 ring-1 ring-destructive/30")}>
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2 font-medium text-destructive-text">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{a.title}</span>
          {!onTopic && <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>Hide options</Button>}
        </div>
        {a.cushion && <p className="text-sm">{a.cushion}</p>}
        <p className="text-xs text-muted-foreground">
          {a.cause ? `${a.cause} ` : ""}Health factor {a.hf.toFixed(2)}, below your At-risk level of {a.act}.
          {` Liquidation means the lender can sell some of your ${a.asset ?? "collateral"} to repay the loan, usually with a penalty.`}
        </p>
      </div>
      <div ref={rowsRef} className="flex flex-col gap-2">
        {a.options.map((o) => (
          <FixOptionRow
            key={o.k} label={o.label} chosen={chosen === o.k} disabled={o.short || !onChoose} recommended={o.recommended && !!onChoose}
            onClick={() => onChoose?.(a.id, o.k)} sub={`${o.sub}${o.short ? "" : ` · ${needsSignatures(a.threshold)}`}`}
          />
        ))}
        {chosen && <Button variant="link" size="sm" className="self-start" onClick={() => focusFirstOption(rowsRef.current)}>Choose another</Button>}
        {a.rule && <p className="text-xs text-muted-foreground">{a.rule.line}</p>}
        {safeAddress && reserveEligible && <UseReserveNow safeAddress={safeAddress} loanId={a.loanId} />}
        {!reserveEligible && <p className="text-xs text-muted-foreground">This loan is not covered by Reserve protection. {a.reserveEligibility.reason ?? "Reserve protection works only for Aave loans on Base."}</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        {a.options.some((o) => o.short) && <p className="text-xs text-muted-foreground">Greyed options need more than this Safe holds. Move funds into the Safe first, or pick another option.</p>}
      </div>
    </div>
  );
}

/**
 * The alert with its options wired to the fix flow (BP-22): choosing one drafts the fix (POST /fixes, a draft only, r30)
 * and the fix card with that draft shows below. A reloaded thread shows the card again while the loan has an open fix.
 */
function AlertWithFix({ safeAddress, alert, onTopic, ruleDrafted }: { safeAddress: string; alert: AlertView; onTopic?: boolean; ruleDrafted?: boolean }) {
  const { pick } = useFixActions(safeAddress, alert.loanId);
  const [chosen, setChosen] = useState(false);
  const fix = useFix(safeAddress, alert.loanId);
  const shown = chosen || ruleDrafted || alert.state === "fixing";
  const drafted = shown ? fix.data?.draft?.option ?? pick.variables ?? null : null;
  const choose = (_id: number, option: "coll" | "repay" | "both") => {
    if (pick.isPending) return;
    pick.mutate(option, { onSuccess: () => setChosen(true) });
  };
  return (
    <div className="flex flex-col gap-2">
      <AlertCard alert={alert} onChoose={choose} onTopic={onTopic} safeAddress={safeAddress} chosen={drafted} />
      {pick.isError && <p role="alert" className="text-sm text-destructive">{pick.error.message}</p>}
      {shown && <LiveFixCard address={safeAddress} loanId={alert.loanId} />}
    </div>
  );
}

/** The alert card for a `data-alert` part: reads the alert, falls back to the stored text while loading. Options draft the fix unless `onChoose` is given. */
export function AlertCardSlot({ safeAddress, alertId, text, onChoose, onTopic }: { safeAddress: string; alertId: number; text?: string } & Pick<AlertCardProps, "onChoose" | "onTopic">) {
  const { data, error } = useAlert(safeAddress, alertId);
  // BP-25: the rule drafted a fix; the existing fix card holds it with its Send to Safe button.
  const ruleDrafted = data?.rule?.outcome === "drafted" && data.state === "live";
  if (data && onChoose) return (
    <>
      <AlertCard alert={data} onChoose={onChoose} onTopic={onTopic} safeAddress={safeAddress} />
      {ruleDrafted && <LiveFixCard address={safeAddress} loanId={data.loanId} />}
    </>
  );
  if (data) return <AlertWithFix safeAddress={safeAddress} alert={data} onTopic={onTopic} ruleDrafted={ruleDrafted} />;
  if (error) return <p role="alert" className="text-sm text-muted-foreground">{text ?? "We could not load this alert."}</p>;
  return text ? <p className="text-sm">{text}</p> : <StateMessage kind="loading" label="Loading this alert…" />;
}
