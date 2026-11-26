"use client";

import { ADD_FUNDS_TEXT } from "@/lib/add-funds-text";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, TriangleAlert, X } from "lucide-react";
import type { Network } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { useOwnedChains } from "@/components/wallet/OwnedChains";
import { sendChainsFor } from "@/components/wallet/tokens";
import { SendToSafe } from "@/components/wallet/SendToSafe";
import { statusLabel, type HealthStatus } from "@/lib/loan-math";
export { statusLabel } from "@/lib/loan-math";
import type { ReserveStatus } from "@/lib/reserve";
import { segmentState } from "@/lib/step-bar";
import { cn } from "@/lib/utils";
import { NetworkChip } from "@/components/ui/network-mark";
export { NetworkChip } from "@/components/ui/network-mark";

/** "base" becomes "Base". Network display names are the id, capitalised. */
export const networkLabel = (id: Network | string) => id.charAt(0).toUpperCase() + id.slice(1);

/** Bottom action bar of a card: sticks to the bottom of the scroll area while the card is taller than it. Label row on top, buttons below, primary last. */
export function ActionFooter({ label, children, className }: { label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("sticky bottom-0 z-10 -mx-4 mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card px-4 py-3", className)}>
      {label && <div className="flex min-w-0 basis-full flex-col gap-1">{label}</div>}
      {children}
    </div>
  );
}

export const dotClass: Record<HealthStatus, string> = { healthy: "bg-success", watch: "bg-warning", risk: "bg-destructive", liquidatable: "bg-destructive ring-2 ring-destructive/30" };
export const textClass: Record<HealthStatus, string> = { healthy: "text-success-text", watch: "text-warning-text", risk: "text-destructive-text", liquidatable: "text-destructive-text" };

export const HealthDot = ({ s }: { s: HealthStatus }) => <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dotClass[s])} />;

export function StatusPill({ s, hf }: { s: HealthStatus; hf?: number }) {
  const solid = s === "liquidatable";
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs", solid ? "bg-destructive text-destructive-foreground" : textClass[s])}>
      {solid ? <TriangleAlert className="size-3" /> : <HealthDot s={s} />}
      {statusLabel[s]}
      {hf !== undefined && <span className="tabular-nums">{hf.toFixed(2)}</span>}
    </span>
  );
}

const reserveDot = { success: "bg-success", warning: "bg-warning", muted: "bg-muted-foreground" } as const;

/** The reserve's one status. The dot carries the colour and the words carry the meaning, so it is never colour-only. */
export function ReserveStatusChip({ s, text }: { s: ReserveStatus; text?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-muted px-2 text-xs", s.tone === "muted" ? "text-muted-foreground" : "text-foreground")}>
      <span className={cn("size-2 rounded-full", reserveDot[s.tone])} />
      {text ?? s.label}
    </span>
  );
}

export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("truncate text-lg font-medium", className)}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export const tooltipStyle = {
  contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12, color: "var(--foreground)" },
  labelStyle: { color: "var(--muted-foreground)" },
  itemStyle: { color: "var(--foreground)" },
};
export const axisProps = { stroke: "var(--muted-foreground)", fontSize: 12, tickLine: false, axisLine: false } as const;

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-medium">{title}</h1>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/** Axis ticks every 0.5 from 0 up to a rounded-up maximum. */
export const hfTicks = (max: number) => Array.from({ length: Math.ceil(max * 2) + 1 }, (_, i) => i / 2);

export function CanCannot({ can, cannot }: { can: string[]; cannot: string[] }) {
  return (
    <div className="grid gap-3 rounded-xl bg-muted p-3 text-sm">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">It can</span>
        {can.map((t) => <span key={t} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{t}</span>)}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">It cannot</span>
        {cannot.map((t) => <span key={t} className="flex items-start gap-2"><X className="mt-0.5 size-4 shrink-0 text-destructive" />{t}</span>)}
      </div>
    </div>
  );
}

/** Returns a ref for the element that should take focus whenever `key` changes (not on the first render). The element needs tabIndex={-1}. */
export function useFocusOnChange<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  const prev = useRef(key);
  useEffect(() => {
    if (Object.is(prev.current, key)) return; // first render, or StrictMode's second effect run
    prev.current = key;
    ref.current?.focus();
  }, [key]);
  return ref;
}

/** The body of the "Add funds" panel: the Safe's address and where it works. Shared by Overview and the chat. */
export function AddFundsBody({ address, networks, assets }: { address: string; networks: (Network | string)[]; assets?: string[] }) {
  // Send only on networks the card lists AND (inside a Safe) the server says the user owns there: an undeployed network's address strands funds.
  const owned = useOwnedChains();
  const listed = networks.flatMap((n) => ({ base: [8453], arbitrum: [42161] })[String(n).toLowerCase() as "base"] ?? []);
  const sendIds = owned ? listed.filter((id) => owned.includes(id)) : listed;
  const canSend = sendChainsFor(sendIds).length > 0;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); } catch { /* clipboard can be blocked */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <>
      <p className="text-sm text-muted-foreground">{ADD_FUNDS_TEXT}</p>
      {canSend && <SendToSafe safe={address} chainIds={sendIds} assets={assets} />}
      {canSend && <p className="text-xs font-medium">Or send from another wallet or an exchange</p>}
      {!canSend && <p className="text-xs text-muted-foreground">Send from your wallet or an exchange to this address, on a network where your Safe is set up.</p>}
      <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
        <code className="min-w-0 flex-1 text-xs break-all">{address}</code>
        <Button variant="outline" size="sm" onClick={copy}>{copied ? <><Check /> Copied</> : <><Copy /> Copy</>}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Same address on each of these networks:</p>
      <div className="flex flex-wrap gap-1.5">{networks.map((n) => <NetworkChip key={n} id={n} />)}</div>
    </>
  );
}

/** One-line receipt for something already sent: a finished form becomes this, not a greyed-out form. */
export const SentLine = ({ children }: { children: ReactNode }) => (
  <p role="status" className="flex items-start gap-2 rounded-xl bg-muted p-3 text-sm"><Check className="mt-0.5 size-4 shrink-0 text-success" />{children}</p>
);

export function StepBar({ labels, step, complete = false }: { labels: string[]; step: number; complete?: boolean }) {
  return (
    <nav aria-label="Onboarding progress" data-slot="step-bar" className="flex items-start gap-1.5 sm:gap-2">
      {labels.map((l, i) => {
        const state = segmentState(i, step, complete);
        return (
          <div key={l} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={cn("h-1.5 rounded-full", state === "done" ? "bg-success/70" : state === "current" ? "bg-primary" : "bg-border")} />
            <span aria-current={state === "current" ? "step" : undefined} className={cn("flex min-h-8 min-w-0 items-start gap-1 rounded-md px-1 py-1 text-[11px] leading-tight", state === "done" ? "font-medium text-success-text" : state === "current" ? "bg-muted font-semibold text-foreground" : "text-muted-foreground")}>
              {state === "done" ? <><Check className="mt-px size-3 shrink-0" aria-hidden />{l}</> : `${i + 1} ${l}`}
            </span>
          </div>
        );
      })}
    </nav>
  );
}

/** Check mark for a selected card, so selection is not shown by the border alone. */
export const SelectedMark = ({ on }: { on: boolean }) => (on ? <Check className="size-4 shrink-0" aria-hidden /> : null);

/** Class for a selectable card (radio or checkbox inside a label). `disabled` dims it and turns off hover. */
export const radioCard = (on: boolean, disabled = false) =>
  cn("flex cursor-pointer flex-col gap-0.5 rounded-xl p-3 text-left ring-1 ring-foreground/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring", on && !disabled ? "bg-muted ring-2 ring-foreground" : !disabled && "hover:bg-muted/50", disabled && "cursor-not-allowed opacity-60");
