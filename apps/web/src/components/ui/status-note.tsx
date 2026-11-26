import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type NoteTone = "info" | "ok" | "warn" | "bad" | "muted";

const TONE: Record<NoteTone, { box: string; icon: typeof Info; iconClass: string }> = {
  info: { box: "bg-[color-mix(in_oklch,var(--link),var(--card)_90%)] ring-[color-mix(in_oklch,var(--link),transparent_70%)]", icon: Info, iconClass: "text-link" },
  ok: { box: "bg-[color-mix(in_oklch,var(--success),var(--card)_90%)] ring-[color-mix(in_oklch,var(--success),transparent_70%)]", icon: CheckCircle2, iconClass: "text-success-text" },
  warn: { box: "bg-[color-mix(in_oklch,var(--warning),var(--card)_90%)] ring-[color-mix(in_oklch,var(--warning),transparent_70%)]", icon: AlertTriangle, iconClass: "text-warning-text" },
  bad: { box: "bg-[color-mix(in_oklch,var(--destructive),var(--card)_90%)] ring-[color-mix(in_oklch,var(--destructive),transparent_70%)]", icon: XCircle, iconClass: "text-destructive-text" },
  muted: { box: "bg-muted ring-border", icon: Info, iconClass: "text-muted-foreground" },
};

/** A tinted note with an icon and words (never colour alone). `bad` and `warn` are announced as alerts. */
export function StatusNote({ tone = "info", children, className }: { tone?: NoteTone; children: ReactNode; className?: string }) {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <div data-slot="status-note" data-tone={tone} role={tone === "bad" ? "alert" : "note"} className={cn("flex items-start gap-2 rounded-lg p-3 text-sm ring-1", t.box, className)}>
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", t.iconClass)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
