"use client";
// The loan page's red banner (BP-23): `riskBanner(hf, fix)` verbatim. "A fix is waiting for signatures in
// your Safe." once a fix is queued; the link goes to the proposal in Safe.
import { TriangleAlert } from "lucide-react";
import { riskBanner } from "@/lib/loan-copy";

export function RiskBanner({ hf, fix, safeLink }: { hf: number; fix: "none" | "draft" | "queued"; safeLink?: string }) {
  return (
    <div data-testid="loan-risk" className="flex flex-wrap items-center gap-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive-text ring-1 ring-destructive/30">
      <TriangleAlert className="size-4 shrink-0" />
      <p role="alert" className="flex min-h-7 min-w-0 flex-1 items-center">{riskBanner(hf, fix)}</p>
      {fix === "queued" && safeLink && <a href={safeLink} target="_blank" rel="noreferrer" className="underline underline-offset-2">Open in Safe</a>}
    </div>
  );
}
