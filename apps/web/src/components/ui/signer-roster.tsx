import { Check, Circle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AddressText } from "@/components/ui/address";

export type SignerStatus = "approved" | "not_yet" | "saving" | "declined";
export type RosterOwner = { address: string; name?: string; isYou: boolean; status: SignerStatus; at?: string };

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** One segment per required approval; `lit` of them are filled. */
export function SignatureBar({ threshold, lit, className }: { threshold: number; lit: number; className?: string }) {
  return (
    <div data-slot="signature-bar" role="img" aria-label={`${Math.min(lit, threshold)} of ${threshold} approvals`} className={cn("flex gap-1", className)}>
      {Array.from({ length: threshold }, (_, i) => (
        <span key={i} data-segment data-lit={i < lit || undefined} className={cn("h-1.5 flex-1 rounded-full", i < lit ? "bg-success" : "bg-border")} />
      ))}
    </div>
  );
}

const STATUS = {
  approved: { word: "Approved", icon: Check, cls: "text-success-text" },
  not_yet: { word: "Not yet", icon: Circle, cls: "text-muted-foreground" },
  saving: { word: "Saving…", icon: Loader2, cls: "text-muted-foreground" },
  declined: { word: "Declined", icon: X, cls: "text-muted-foreground" },
} as const;

/** The owners and where each stands: you first, each address short with copy (and an explorer link when `chainId` is given). Status is an icon plus a word; rows are at least 44 px tall. */
export function SignerRoster({ owners, chainId, className }: { owners: RosterOwner[]; chainId?: number; className?: string }) {
  // "You" first, then the others in the order given.
  const ordered = [...owners].sort((a, b) => Number(b.isYou) - Number(a.isYou));
  return (
    <ul data-slot="signer-roster" className={cn("flex flex-col divide-y divide-border", className)}>
      {ordered.map((o) => {
        const s = STATUS[o.status];
        const Icon = s.icon;
        return (
          <li key={o.address} data-status={o.status} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{o.isYou ? "You" : o.name ?? "Co-owner"}</p>
              <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground"><AddressText address={o.address} chainId={chainId} />{o.at ? <span>· {o.at}</span> : null}</p>
            </div>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-sm", s.cls)}>
              <Icon aria-hidden className={cn("size-4", o.status === "saving" && "animate-spin")} />
              {s.word}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
