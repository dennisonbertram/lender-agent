"use client";
// "Why $4,000?": one link-style button that opens the plain sentence from `limitWhy` (VC-02). Same component on every surface.
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { splitWhy } from "@/lib/borrow-limit";

export function LimitWhy({ why }: { why?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!why) return null;
  const { label, text } = splitWhy(why);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" variant="link" size="inline" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{label}</Button>
      {open && <p id={id} className="text-xs text-muted-foreground">{text}</p>}
    </div>
  );
}
