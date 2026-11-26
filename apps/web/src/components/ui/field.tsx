"use client";

import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Tone = "hint" | "error" | "warning" | "success";
const toneClass: Record<Tone, string> = {
  hint: "text-muted-foreground",
  error: "text-destructive",
  warning: "text-warning",
  success: "text-success",
};

/** One message line under a control. Always rendered, also when empty, so its height is reserved. */
export function FieldMessage({ id, tone = "hint", className, children }: { id: string; tone?: Tone; className?: string; children?: ReactNode }) {
  return (
    <p id={id} data-slot="field-message" aria-live="polite" className={cn("min-h-4 text-xs leading-4", toneClass[tone], className)}>
      {children}
    </p>
  );
}

type ControlProps = { id: string; "aria-invalid": boolean; "aria-describedby": string; className?: string };

/** Label, control and one reserved message line. The control is a render prop so it keeps its own element type. */
export function Field({ label, labelHidden, message, tone = "hint", suffix, className, messageClassName, children }: {
  label: string; labelHidden?: boolean; message?: ReactNode; tone?: Tone; suffix?: string;
  className?: string; messageClassName?: string; children: (p: ControlProps) => ReactNode;
}) {
  const id = useId();
  const control = children({
    id,
    "aria-invalid": tone === "error",
    "aria-describedby": `${id}-msg${suffix ? ` ${id}-sfx` : ""}`,
    className: suffix ? "pr-14" : undefined,
  });
  return (
    <div data-slot="field" className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} className={labelHidden ? "sr-only" : "text-xs font-normal text-muted-foreground"}>{label}</Label>
      {suffix ? (
        <div className="relative">
          {control}
          <span id={`${id}-sfx`} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-muted-foreground">{suffix}</span>
        </div>
      ) : control}
      <FieldMessage id={`${id}-msg`} tone={tone} className={messageClassName}>{message}</FieldMessage>
    </div>
  );
}

/** Moves focus to the first control flagged aria-invalid inside root. Returns whether one was found. */
export function focusFirstInvalid(root: HTMLElement | null): boolean {
  const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
  el?.focus();
  return !!el;
}
