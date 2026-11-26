import { useEffect, useState } from "react";
import { PiggyBank } from "lucide-react";
import { useApp } from "@/store";
import { PageHeader } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableHeadRow, TableRow } from "@/components/ui/table";
import { timeLabel } from "@/lib/activity-copy";
import { cn } from "@/lib/utils";

export function ActivityLog() {
  const { activity, safe } = useApp();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Activity" sub={`What the agent, you and co-signers did in ${safe.name}`} />
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {activity.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">{`Nothing has happened in ${safe.name} yet. Agent checks, proposals and signatures will show up here.`}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableHeadRow className="text-left text-xs text-muted-foreground">
                <TableHead className="hidden w-32 px-3 sm:table-cell">Time</TableHead>
                <TableHead className="hidden w-40 px-3 sm:table-cell">Actor</TableHead>
                <TableHead className="px-3">Event</TableHead>
              </TableHeadRow>
            </TableHeader>
            <TableBody>
              {activity.map((e) => (
                <TableRow key={e.id} className="h-auto hover:bg-transparent">
                  <TableCell className="hidden px-3 py-2.5 text-xs text-muted-foreground sm:table-cell">{timeLabel(e, now)}</TableCell>
                  <TableCell className="hidden px-3 py-2.5 align-middle sm:table-cell">
                    <ActorPill actor={e.actor} />
                  </TableCell>
                  <TableCell className="px-3 py-2.5 whitespace-normal">
                    <div className="mb-1 sm:hidden"><ActorPill actor={e.actor} /></div>
                    {e.text}
                    {e.detail && <span className="block text-xs text-muted-foreground">{e.detail}</span>}
                    <span className="block text-xs text-muted-foreground sm:hidden">{timeLabel(e, now)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function ActorPill({ actor }: { actor: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs", actor === "You" || actor === "Co-signer" ? "bg-foreground text-background" : actor === "Agent (reserve)" ? "text-warning-text ring-1 ring-warning/50" : "ring-1 ring-foreground/25")}>
      {actor === "Agent (reserve)" && <PiggyBank className="size-3" />}
      {actor}
    </span>
  );
}
