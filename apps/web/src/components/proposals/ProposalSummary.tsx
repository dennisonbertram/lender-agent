"use client";
// The short card in the chat thread, dock and sheet: headline, three numbers, who approved, one button.
// Signing never happens here: the button goes to the proposal page (or copies the link while waiting).
import { useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { NetworkChip } from "@/components/common";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatAddress } from "@/lib/explorer";
import { actionLabel, coOwnerName, describe, isOwner, type Tone } from "@/components/proposals/review-state";
import type { ProposalView } from "@/server/proposals/view";

const DOT: Record<Tone, string> = { warning: "bg-warning", success: "bg-success", destructive: "bg-destructive", muted: "bg-muted-foreground", working: "bg-[var(--status-working)]" };

export function ProposalSummary({ p, href }: { p: ProposalView; href: string }) {
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const d = describe(p, { phase: "idle", lastSignerSends: true });
  const t = p.threshold ?? p.signedCount;
  const k = p.owners?.filter((o) => o.signed).length ?? p.signedCount;
  const numbers = p.facts?.numbers ?? [];
  const live = p.stage === "queued" && !!p.owners && p.state !== "settling";
  const term = (l: string) => p.facts?.terms.find((x) => x.label === l)?.value;
  // One muted line from what the plan already carries: network, lender and liquidation price.
  const network = term("Network");
  const lender = term("Lender");
  const liquidation = term("Liquidation price");
  const label = d.id === "waiting_for_others" ? (copied ? "Link copied" : `Copy link for ${coOwnerName(p)}`) : actionLabel(d);
  const copy = async () => {
    const url = new URL(href, window.location.origin).toString();
    // "Link copied" only after the clipboard took it; a denied clipboard shows the link to select by hand.
    try {
      await navigator.clipboard.writeText(url);
      setManualLink(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setManualLink(url);
    }
  };
  return (
    <div data-slot="proposal-summary" data-state={d.id} className="flex flex-col gap-3 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{p.title}</span>
        {d.pill && <Badge variant="outline" className="shrink-0"><span aria-hidden className={cn("size-1.5 rounded-full", DOT[d.tone])} />{d.pill}</Badge>}
      </div>
      {numbers.length > 0 && (
        <dl className="grid grid-cols-3 gap-2">
          {numbers.map((n) => (
            <div key={n.label} className="min-w-0"><dd className="truncate font-semibold tabular-nums">{n.value}</dd><dt className="text-xs text-muted-foreground">{n.label}</dt></div>
          ))}
        </dl>
      )}
      {(network || lender || liquidation) && <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">{network && <>On <NetworkChip id={network} className="px-1.5 py-0" /></>}{lender && <>{network && " · "}{lender}</>}{liquidation && <>{(network || lender) && " · "}Liquidation price {liquidation}</>}</p>}
      {d.id === "sending_unknown" && <p className="text-xs text-muted-foreground">{p.sentence}</p>}
      {live && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{k} of {t} approved</span>
          {[...p.owners!].sort((a, b) => Number(b.isYou) - Number(a.isYou)).map((o) => (
            <span key={o.address} className="inline-flex items-center gap-1">
              {o.signed ? <Check aria-hidden className="size-3 text-success-text" /> : <span aria-hidden className="size-2 rounded-full ring-1 ring-muted-foreground" />}
              <span title={o.address}>{o.isYou ? "You" : formatAddress(o.address)}</span>
              {!o.signed && !o.isYou && <span>waiting</span>}
              {!o.signed && o.isYou && <span>not yet</span>}
            </span>
          ))}
        </p>
      )}
      {d.id === "settling" && <p className="text-xs text-muted-foreground">{d.headline}. {d.body}</p>}
      <div className="flex flex-col gap-1">
        {d.id === "settling" ? null : d.id === "waiting_for_others" ? (
          <Button size="xl" className="w-full" onClick={copy}>{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{label}</Button>
        ) : d.id === "sending_unknown" ? (
          <a className="inline-flex min-h-11 items-center font-medium underline underline-offset-2" href={p.links.queue} target="_blank" rel="noreferrer">Check Safe queue</a>
        ) : d.id === "sending" ? (
          <>
            <Button size="xl" variant="secondary" className="w-full" disabled>{label}</Button>
            {p.links.tx && <a className="inline-flex min-h-11 items-center gap-1 underline underline-offset-2" href={p.links.tx} target="_blank" rel="noreferrer">View transaction <ExternalLink aria-hidden className="size-3" /></a>}
          </>
        ) : (
          <Button size="xl" className="w-full" variant={d.id.startsWith("needs") || d.id === "ready_to_send" ? "default" : "outline"} render={<Link href={href} />}>{label}</Button>
        )}
        {manualLink && (
          <p className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Copying is blocked in this browser. Select this link and copy it yourself:</span>
            <input readOnly value={manualLink} aria-label="Proposal link" onFocus={(e) => e.currentTarget.select()} className="w-full rounded bg-background px-2 py-1" />
          </p>
        )}
      </div>
    </div>
  );
}
