"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SendChain } from "./tokens";
import { REPLACED_TEXT, stalledText, useTransferOutcome } from "./useTransferOutcome";

/** A transaction toast. "confirm" waits for the wallet; "sending" follows the hash on the network and settles itself. */
type Toast =
  | { id: number; kind: "confirm" }
  | { id: number; kind: "sending"; hash: `0x${string}`; chain: SendChain; text: string }
  | { id: number; kind: "failed" | "cancelled"; text: string };

export type TxToastApi = {
  /** Shows "Confirm in your wallet…" and returns the toast's id. */
  confirm: () => number;
  /** The wallet signed: "Sending …" with a spinner, then success / failed / cancelled from the network. */
  sending: (id: number, o: { hash: `0x${string}`; chain: SendChain; text: string }) => void;
  /** The wallet refused or errored: a toast that stays until closed. */
  fail: (id: number, text: string, cancelled?: boolean) => void;
  dismiss: (id: number) => void;
};

const NOOP: TxToastApi = { confirm: () => 0, sending: () => {}, fail: () => {}, dismiss: () => {} };
const TxToastContext = createContext<TxToastApi>(NOOP);

/** The toast API; a no-op outside the provider, so callers never need to check. */
export const useTxToasts = () => useContext(TxToastContext);

export const TOAST_DISMISS_MS = 8000;

export function TxToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const replace = useCallback((id: number, t: Toast) => setToasts((all) => (all.some((x) => x.id === id) ? all.map((x) => (x.id === id ? t : x)) : [...all, t])), []);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  const api = useMemo<TxToastApi>(() => ({
    confirm: () => { const id = next.current++; replace(id, { id, kind: "confirm" }); return id; },
    sending: (id, o) => replace(id, { id, kind: "sending", ...o }),
    fail: (id, text, cancelled) => replace(id, { id, kind: cancelled ? "cancelled" : "failed", text }),
    dismiss,
  }), [replace, dismiss]);
  return (
    <TxToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" role="region" aria-label="Transactions" className="pointer-events-none fixed right-3 bottom-3 z-[60] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
        {toasts.map((t) => <ToastCard key={t.id} toast={t} onClose={() => dismiss(t.id)} onHash={(h) => t.kind === "sending" && replace(t.id, { ...t, hash: h })} />)}
      </div>
    </TxToastContext.Provider>
  );
}

function Card({ icon, children, onClose }: { icon: ReactNode; children: ReactNode; onClose: () => void }) {
  return (
    <div className="pointer-events-auto flex items-start gap-2 rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      <Button variant="ghost" size="icon-sm" aria-label="Close" className="-mt-1 -mr-1 shrink-0" onClick={onClose}><X /></Button>
    </div>
  );
}

function ToastCard({ toast, onClose, onHash }: { toast: Toast; onClose: () => void; onHash: (h: `0x${string}`) => void }) {
  if (toast.kind === "confirm") return <Card icon={<Loader2 className="size-4 animate-spin" aria-hidden />} onClose={onClose}><p>Confirm in your wallet…</p></Card>;
  if (toast.kind === "sending") return <SendingCard toast={toast} onClose={onClose} onHash={onHash} />;
  return <Card icon={<X className="size-4 text-destructive-text" aria-hidden />} onClose={onClose}><p>{toast.text}</p></Card>;
}

function SendingCard({ toast, onClose, onHash }: { toast: Extract<Toast, { kind: "sending" }>; onClose: () => void; onHash: (h: `0x${string}`) => void }) {
  const outcome = useTransferOutcome(toast.hash, toast.chain.id, onHash);
  useEffect(() => {
    if (outcome !== "success") return;
    const timer = setTimeout(onClose, TOAST_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [outcome, onClose]);
  if (outcome === "success") {
    return (
      <Card icon={<Check className="size-4 text-success" aria-hidden />} onClose={onClose}>
        <p>Sent · <a href={`${toast.chain.explorerTx}${toast.hash}`} target="_blank" rel="noreferrer" className="underline">View on {toast.chain.explorerName}</a></p>
      </Card>
    );
  }
  if (outcome === "reverted") {
    return (
      <Card icon={<X className="size-4 text-destructive-text" aria-hidden />} onClose={onClose}>
        <p>The transfer failed on the network. Nothing left your wallet except the network fee.</p>
        <a href={`${toast.chain.explorerTx}${toast.hash}`} target="_blank" rel="noreferrer" className="text-xs underline">View on {toast.chain.explorerName}</a>
      </Card>
    );
  }
  if (outcome === "cancelled") return <Card icon={<X className="size-4 text-destructive-text" aria-hidden />} onClose={onClose}><p>You cancelled this transfer in your wallet.</p></Card>;
  if (outcome === "replaced") return <Card icon={<X className="size-4 text-destructive-text" aria-hidden />} onClose={onClose}><p>{REPLACED_TEXT}</p></Card>;
  if (outcome === "stalled") {
    return (
      <Card icon={<Loader2 className="size-4" aria-hidden />} onClose={onClose}>
        <p>{stalledText(toast.chain.explorerName)}</p>
        <a href={`${toast.chain.explorerTx}${toast.hash}`} target="_blank" rel="noreferrer" className="text-xs underline">View on {toast.chain.explorerName}</a>
      </Card>
    );
  }
  return <Card icon={<Loader2 className="size-4 animate-spin" aria-hidden />} onClose={onClose}><p>{toast.text}</p></Card>;
}
