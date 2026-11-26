"use client";
import Link from "next/link";
import { PiggyBank } from "lucide-react";
import { RESERVE_ONE_LINER, showReserveNav } from "@/components/reserve/reserve-nav";
import { useShell } from "@/components/shell/ShellContext";

/** Where the Reserve is found while it has no nav item (no Aave loan, none linked). */
export function ReserveRow({ address }: { address: string }) {
  const { loans, reserve } = useShell();
  if (showReserveNav(loans, reserve)) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3 text-sm ring-1 ring-foreground/10">
      <span className="flex min-w-0 items-start gap-2">
        <PiggyBank className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0"><span className="block font-medium">Reserve</span><span className="block text-muted-foreground">{RESERVE_ONE_LINER}</span></span>
      </span>
      <Link className="underline" href={`/s/${address}/reserve`}>Open Reserve</Link>
    </div>
  );
}
