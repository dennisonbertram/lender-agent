import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Check, TriangleAlert, X } from "lucide-react";
import { Copy } from "lucide-react";
import { PRICES, networkName, type Network } from "@/data";
import { networkList } from "@/lib/networks";
import { requiredSignatures, stageLine } from "@/lib/loan-copy";
import { advanceAction, stoppedLine, testRunLine } from "@/lib/proposals";
import { useApp } from "@/store";
import { SafeSummaryDialog } from "@/components/SafeSummaryDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { statusLabel, type HealthStatus } from "@/lib/loan-math";
export { statusLabel } from "@/lib/loan-math";
import type { ReserveStatus } from "@/lib/reserve";
import { segmentState } from "@/lib/step-bar";
import { cn } from "@/lib/utils";

/** Text chip with a network's name. Network marks are text, no logos. */
export const NetworkChip = ({ id, className }: { id: Network; className?: string }) => (
  <span className={cn("inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground", className)}>{networkName(id)}</span>
);

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

export const OpenInSafeLink = ({ id }: { id: string }) => <SafeSummaryDialog id={id} />;

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

/** Simulated Safe signature: start() waits 1.2 s, then calls onSigned. Changing resetKey (the Safe) cancels it. */
export function useSigning(onSigned: () => void, resetKey: string): [boolean, () => void] {
  const [signing, setSigning] = useState(false);
  useEffect(() => setSigning(false), [resetKey]);
  useEffect(() => {
    if (!signing) return;
    const t = setTimeout(() => { setSigning(false); onSigned(); }, 1200);
    return () => clearTimeout(t);
  }, [signing]); // eslint-disable-line react-hooks/exhaustive-deps
  return [signing, () => setSigning(true)];
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

/** Status of one proposal: 4-step bar, one sentence, and the actions. Rejected or out-of-date proposals show only the stopped sentence. The caller shows the title. */
export function ProposalStatus({ id, compact }: { id: string; compact?: boolean }) {
  const { proposals, safe, advance, reject, edit, proposerActive } = useApp();
  const p = proposals[id];
  if (!p || p.stage === -2) return null;
  if (p.stage < 0) {
    return <p role="status" className="text-sm text-foreground">{stoppedLine(p.stage === -1 ? -1 : -3, !!p.queued)}{p.queued && <> <OpenInSafeLink id={id} /></>}</p>;
  }
  const open = p.stage < 3;
  const adv = advanceAction(p.stage, requiredSignatures(safe.threshold));
  const run = testRunLine(p.hfAfter, p.feeUsd);
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden className="flex gap-1">
        {[0, 1, 2, 3].map((i) => <span key={i} className={cn("h-1 flex-1 rounded-full", p.stage === 3 ? "bg-success" : i <= p.stage ? "bg-foreground" : "bg-border")} />)}
      </div>
      {open ? (
        <p role="status" className="text-sm text-foreground">{stageLine(p.stage, requiredSignatures(safe.threshold))}</p>
      ) : (
        <p role="status" className="flex items-start gap-2 text-sm text-foreground"><Check className="mt-0.5 size-4 shrink-0 text-success" />{stageLine(3, 0)}</p>
      )}
      {open && compact && p.stage >= 1 && <div><OpenInSafeLink id={id} /></div>}
      {open && !compact && (
        <div className="flex flex-wrap items-center gap-2">
          {adv && <Button variant={adv.variant} disabled={p.stage === 0 && (!proposerActive || run.blocked)} aria-label={`${adv.label}: ${p.title}`} onClick={() => advance(id)}>{adv.label}</Button>}
          {p.stage === 0 && p.spec.kind === "open" && <Button variant="outline" aria-label={`Edit: ${p.title}`} onClick={() => edit(id)}>Edit</Button>}
          {p.stage >= 1 && <OpenInSafeLink id={id} />}
          <Button variant="ghost" aria-label={`Reject: ${p.title}`} onClick={() => reject(id)}>Reject</Button>
        </div>
      )}
    </div>
  );
}

/** Numbered progress bar for the onboarding and Get cash cards. `step` is zero-based. */
/** The body of the "Add funds" panel: the Safe's address, where it works, and the demo deposit. Shared by Overview and the chat. */
export function AddFundsBody() {
  const { safe, simulateDeposit } = useApp();
  const [copied, setCopied] = useState(false);
  const [received, setReceived] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(safe.address); } catch { /* clipboard can be blocked */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const safeNets = safe.networks.map((n) => n.id);
  const depositOn = safeNets.includes("base") ? "base" : safeNets[0];
  return (
    <>
      <p className="text-sm text-muted-foreground">Send ETH, wstETH or WBTC to this address. These are what you can borrow against.</p>
      <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
        <code className="min-w-0 flex-1 text-xs break-all">{safe.address}</code>
        <Button variant="outline" size="sm" onClick={copy}>{copied ? <><Check /> Copied</> : <><Copy /> Copy</>}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Same address on each of these networks:</p>
      <div className="flex flex-wrap gap-1.5">{safeNets.map((n) => <NetworkChip key={n} id={n} />)}</div>
      {received ? <p className="text-xs text-muted-foreground">Demo deposit received: 5 ETH on {networkList([depositOn])}.</p> : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { simulateDeposit(depositOn); setReceived(true); }}>Simulate a deposit</Button>
          <span className="text-xs text-muted-foreground">Demo: adds 5 ETH on {networkList([depositOn])}.</span>
        </div>
      )}
    </>
  );
}

/** One-line receipt for something already sent: a finished form becomes this, not a greyed-out form. */
export const SentLine = ({ children }: { children: ReactNode }) => (
  <p role="status" className="flex items-start gap-2 rounded-xl bg-muted p-3 text-sm"><Check className="mt-0.5 size-4 shrink-0 text-success" />{children}</p>
);

export function StepBar({ labels, step, complete = false }: { labels: string[]; step: number; complete?: boolean }) {
  return (
    <div data-slot="step-bar" className="flex items-center gap-2">
      {labels.map((l, i) => {
        const state = segmentState(i, step, complete);
        return (
          <div key={l} className="flex flex-1 flex-col gap-1">
            <span className={cn("h-1 rounded-full", state === "done" ? "bg-foreground/40" : state === "current" ? "bg-foreground" : "bg-border")} />
            <span aria-current={state === "current" ? "step" : undefined} className={cn("flex items-center gap-1 text-xs", state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
              {state === "done" ? <><Check className="size-3" aria-hidden />{l}</> : `${i + 1} ${l}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** "Add agent to this Safe" button with its signing spinner. Used by Overview, Chat and Settings. */
export function AddAgentButton({ size, className }: { size?: ComponentProps<typeof Button>["size"]; className?: string }) {
  const { addProposer, safe } = useApp();
  const [signing, startSigning] = useSigning(addProposer, safe.id);
  return (
    <Button size={size} className={className} disabled={signing} onClick={startSigning}>
      {signing ? <><Spinner /> Waiting for your signature</> : "Add agent to this Safe"}
    </Button>
  );
}

/** Check mark for a selected card, so selection is not shown by the border alone. */
export const SelectedMark = ({ on }: { on: boolean }) => (on ? <Check className="size-4 shrink-0" aria-hidden /> : null);

/** Class for a selectable card (radio or checkbox inside a label). `disabled` dims it and turns off hover. */
export const radioCard = (on: boolean, disabled = false) =>
  cn("flex cursor-pointer flex-col gap-0.5 rounded-xl p-3 text-left ring-1 ring-foreground/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring", on && !disabled ? "bg-muted ring-2 ring-foreground" : !disabled && "hover:bg-muted/50", disabled && "cursor-not-allowed opacity-60");
