"use client";
// "Use reserve now" under an alert's options (BP-42, VC-01): last in the list, "Runs now, without a signature",
// a confirm dialog "Use {x} from reserve?", disabled with the reason when the reserve is off, empty or at its limit.
import { useState } from "react";
import { useReserveNowOption, useUseReserveNow } from "@/client/reserve";
import type { ReserveNowOption } from "@/server/reserve/executor/use-now";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function UseReserveNow({ safeAddress, loanId }: { safeAddress: string; loanId: string }) {
  const { data: o } = useReserveNowOption(safeAddress, loanId);
  const run = useUseReserveNow(safeAddress, loanId);
  const [reviewed, setReviewed] = useState<ReserveNowOption | null>(null);
  const open = reviewed !== null;
  if (!o) return null; // no reserve linked, or not an owner of both Safes: the option is not offered
  const off = !o.enabled || !o.binding;
  return (
    <>
      <Button variant="outline" disabled={off || run.isPending} onClick={() => { if (o.binding) setReviewed(o); }} className="h-auto min-h-11 flex-col items-start gap-0 py-2 whitespace-normal disabled:opacity-100">
        <span className={cn("w-full text-left", off && "opacity-50")}>Use reserve now</span>
        <span className={cn("text-left text-xs font-normal", off ? "text-muted-foreground" : "opacity-80")}>{off ? o.message ?? o.label : o.label}</span>
      </Button>
      {run.data && <p role="status" className="text-sm">{run.data.message}</p>}
      {run.error && <p role="alert" className="text-sm text-destructive-text">{run.error.message}</p>}
      <AlertDialog open={open} onOpenChange={(v) => { if (!run.isPending && !v) setReviewed(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{reviewed?.confirm ?? "Use reserve?"}</AlertDialogTitle>
            <AlertDialogDescription>This exact amount is the most the reserve can request for this loan. If the loan, reserve, or limits change before you confirm, you’ll need to review the updated amount.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={run.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={run.isPending || !reviewed?.binding} onClick={(e) => { e.preventDefault(); if (reviewed?.binding) run.mutate(reviewed.binding, { onSettled: () => setReviewed(null) }); }}>
              {run.isPending ? <><Spinner /> Working</> : "Use reserve"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
