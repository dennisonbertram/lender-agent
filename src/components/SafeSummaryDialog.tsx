import { PRICES } from "@/data";
import { requiredSignatures, stageLine } from "@/lib/loan-copy";
import { stoppedLine, testRunLine } from "@/lib/proposals";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** "Open in Safe": read-only demo stand-in for the Safe app page of one proposal. Reads the proposal by id so it is never stale. */
export function SafeSummaryDialog({ id }: { id: string }) {
  const { proposals, safe } = useApp();
  const p = proposals[id];
  if (!p || p.stage === -2) return null;
  const status = p.stage < 0 ? stoppedLine(p.stage === -1 ? -1 : -3, !!p.queued) : stageLine(p.stage, p.stage === 3 ? 0 : requiredSignatures(safe.threshold));
  return (
    <Dialog>
      <DialogTrigger className="relative inline-flex cursor-pointer items-center text-link underline underline-offset-2 after:absolute after:-inset-y-3 after:inset-x-0">
        Open in Safe
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p.title}</DialogTitle>
          <DialogDescription>Demo stand-in for your Safe app. Co-signers see this same summary there. Signing happens in Safe, not here.</DialogDescription>
        </DialogHeader>
        <p>{p.outcome}</p>
        <ol className="flex flex-col gap-1">
          {p.steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">{i + 1}</span>
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">{testRunLine(p.hfAfter, p.feeUsd).text}</p>
        <p>{status}</p>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
