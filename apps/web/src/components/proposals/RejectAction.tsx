"use client";
// The owner's Reject button: it asks first, and says honestly what still counts in Safe{Wallet}.
import { useRef, useState, type KeyboardEvent } from "react";
import { useRejectProposal } from "@/client/reject";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** Tab and Shift+Tab cycle inside the dialog (a dialog must never hand focus to the page behind it). */
export function trapTab(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter((el) => !el.hasAttribute("disabled"));
  if (items.length === 0) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !e.currentTarget.contains(at))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (at === last || !e.currentTarget.contains(at))) { e.preventDefault(); first.focus(); }
}

/** What rejecting here does and does not do: approvals already given are lost here, but Safe{Wallet} can still run it until it is rejected there. */
export function RejectWarning({ approvals, queueHref }: { approvals: number; queueHref?: string }) {
  return (
    <>
      <span>Nobody will be asked to approve it here any more, and we&apos;ll remove it from your Safe&apos;s queue.</span>
      {approvals > 0 && (
        <span className="mt-2 block">
          {approvals === 1 ? "1 approval is already given" : `${approvals} approvals are already given`}. It stays approved in Safe{"{Wallet}"}, so it could still be sent from there until it is rejected there too.
          {queueHref && <> <a className="underline underline-offset-2" href={queueHref} target="_blank" rel="noreferrer">Reject in Safe{"{Wallet}"}</a></>}
        </span>
      )}
    </>
  );
}

export function RejectAction({ safeAddress, proposalId, title, approvals, queueHref }: { safeAddress: string; proposalId: string; title: string; approvals: number; queueHref?: string }) {
  const reject = useRejectProposal(safeAddress, proposalId);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={trigger} variant="ghost" size="inline" className="inline-flex min-h-11 items-center text-sm underline underline-offset-2" aria-label={`Reject: ${title}`} onClick={() => { reject.reset(); setOpen(true); }}>Reject this plan</Button>
      <AlertDialog open={open} onOpenChange={(v) => { if (reject.isPending) return; setOpen(v); if (!v) setTimeout(() => trigger.current?.focus(), 0); }}>
        <AlertDialogContent onKeyDown={trapTab}>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this plan?</AlertDialogTitle>
            <AlertDialogDescription>
              <RejectWarning approvals={approvals} queueHref={queueHref} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          {reject.isError && <p role="alert" className="text-sm text-destructive-text">{reject.error.message}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus className="min-h-11 px-4" disabled={reject.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="min-h-11 px-4" disabled={reject.isPending} onClick={(e) => { e.preventDefault(); reject.mutate(undefined, { onSuccess: () => { setOpen(false); setTimeout(() => trigger.current?.focus(), 0); } }); }}>
              {reject.isPending ? <><Spinner /> Rejecting</> : "Reject plan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
