"use client";

import { useState } from "react";
import { getAddress, isAddress } from "viem";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { explorerAddressUrl, explorerName, explorerTxUrl, formatAddress, safeAppUrl } from "@/lib/explorer";

const iconBtn =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-3.5";
const external = { target: "_blank", rel: "noopener noreferrer" } as const;

export function AddressText({ address, chainId, label, showSafeApp, className }: {
  address: string;
  chainId?: number;
  label?: string;
  showSafeApp?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const full = isAddress(address, { strict: false }) ? getAddress(address) : address;
  const explorer = chainId === undefined ? null : explorerAddressUrl(chainId, address);
  const name = chainId === undefined ? null : explorerName(chainId);
  const safeUrl = showSafeApp && chainId !== undefined ? safeAppUrl(chainId, address) : null;
  const copy = async () => {
    let ok = true;
    try { await navigator.clipboard.writeText(full); } catch { ok = false; /* clipboard can be blocked */ }
    setCopied(ok ? "copied" : "failed");
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5", className)}>
      {label && <span className="text-muted-foreground">{label}</span>}
      <span title={full} className="min-w-0 font-mono tabular-nums">{formatAddress(address)}</span>
      <button type="button" onClick={copy} aria-label="Copy address" className={iconBtn}>
        {copied === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
      </button>
      {copied && <span role="status" className="text-xs text-muted-foreground">{copied === "copied" ? "Copied" : "Copy failed"}</span>}
      {explorer && (
        <a href={explorer} aria-label={`View on ${name}`} className={iconBtn} {...external}><ExternalLink aria-hidden /></a>
      )}
      {safeUrl && (
        <a href={safeUrl} className="shrink-0 text-sm text-primary underline-offset-4 hover:underline" {...external}>Open in Safe</a>
      )}
    </span>
  );
}

export function TxHashLink({ chainId, hash, label }: { chainId: number; hash: string; label?: string }) {
  const url = explorerTxUrl(chainId, hash);
  const name = explorerName(chainId);
  const short = `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1">
      {label && <span className="text-muted-foreground">{label}</span>}
      <span title={hash} className="min-w-0 font-mono tabular-nums">{short}</span>
      {url && (
        <a href={url} aria-label={`View transaction on ${name}`} className={iconBtn} {...external}><ExternalLink aria-hidden /></a>
      )}
    </span>
  );
}
