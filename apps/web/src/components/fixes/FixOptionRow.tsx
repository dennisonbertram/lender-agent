"use client";
// One fix option as a toggle button (VC-03): a click drafts the fix, so the chosen row shows a check and a ring.
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type FixOptionRowProps = {
  label: string;
  sub: string;
  chosen: boolean;
  disabled?: boolean;
  recommended?: boolean;
  onClick: () => void;
};

export function FixOptionRow({ label, sub, chosen, disabled, recommended, onClick }: FixOptionRowProps) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed",
        chosen && "ring-2 ring-foreground/35",
      )}
    >
      <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-foreground/40", chosen && "border-foreground bg-foreground text-background", disabled && "opacity-50")}>
        {chosen && <Check className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("flex w-full items-start gap-2", disabled && "opacity-50")}>
          <span className="min-w-0 flex-1">{label}</span>
          {recommended && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">Recommended</span>}
        </span>
        <span className={cn("text-xs", disabled ? "text-muted-foreground" : "opacity-80")}>{sub}</span>
      </span>
    </button>
  );
}

/** Moves focus to the first usable option in `root` (the "Choose another" action). Drafts nothing. */
export function focusFirstOption(root: HTMLElement | null) {
  root?.querySelector<HTMLButtonElement>("button[aria-pressed]:not(:disabled)")?.focus();
}
