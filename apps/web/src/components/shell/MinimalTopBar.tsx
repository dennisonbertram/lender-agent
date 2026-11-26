"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AddressText } from "@/components/ui/address";

/** The shell's fallback header while a Safe loads or fails to load: which Safe, another Safe, sign out. */
export function MinimalTopBar({ address, chainId, onSignOut }: { address: string; chainId?: number; onSignOut?: () => void }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-sm">
      <AddressText address={address} chainId={chainId} label="Safe" className="text-xs" />
      <Link href="/onboarding" className="ml-auto text-sm text-primary underline-offset-4 hover:underline pointer-coarse:py-3">Pick another Safe</Link>
      {onSignOut && <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={onSignOut}>Sign out</Button>}
    </header>
  );
}
