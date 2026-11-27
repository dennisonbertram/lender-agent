"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AddressText } from "@/components/ui/address";
import { GuideButton } from "@/components/guide/Guide";

/** The shell's fallback header while a Safe loads or fails to load: which Safe, another Safe, sign out.
    `guide` is false while the Safe is still loading — the destination (and its access) is not settled
    yet, so offering a walkthrough for it would flash controls the user may never be allowed to see. */
export function MinimalTopBar({ address, chainId, guide = true, onSignOut }: { address: string; chainId?: number; guide?: boolean; onSignOut?: () => void }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-sm">
      <AddressText address={address} chainId={chainId} label="Safe" className="text-xs" />
      <Link href="/onboarding" className="ml-auto text-sm text-primary underline-offset-4 hover:underline pointer-coarse:py-3">Pick another Safe</Link>
      {guide && <GuideButton />}
      {onSignOut && <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={onSignOut}>Sign out</Button>}
    </header>
  );
}
