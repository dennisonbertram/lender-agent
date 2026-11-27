"use client";
import { usePathname } from "next/navigation";
import { use, type ReactNode } from "react";
import { useReserve } from "@/client/reserve";
import { useSafeSummary, useSafes, ApiError } from "@/client/safes";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { AppShell } from "@/components/shell/AppShell";
import { WrongWallet } from "@/components/proposals/WrongWallet";
import { MinimalTopBar } from "@/components/shell/MinimalTopBar";
import { safePaths } from "@/components/shell/Sidebar";
import { ShellProvider } from "@/components/shell/ShellContext";
import { StateMessage } from "@/components/ui/state-message";
import { describeError } from "@/lib/errors";
import { useSession, useSignOut } from "@/client/auth/useSession";
import { shortAddress } from "@/lib/address";
import { OwnedChainsProvider } from "@/components/wallet/OwnedChains";
import type { Safe } from "@/lib/types";
import { NETWORK_OF } from "@/shared/types";

/** Kept short: the mockup has no wording for this, so this is the plan's wording condensed. */
const OWNERS_DIFFER_NOTICE = "The owners of this Safe differ between networks. You can see and act on the networks you own; chat needs ownership on all of them.";

function PendingSafeRail() {
  return (
    <aside aria-hidden="true" className="hidden w-[232px] shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col md:gap-6 md:p-4">
      <div className="h-9 w-40 animate-pulse rounded-md bg-muted/70" />
      <div className="flex flex-col gap-3">
        <div className="h-9 w-full animate-pulse rounded-md bg-muted/50" />
        <div className="h-9 w-4/5 animate-pulse rounded-md bg-muted/50" />
        <div className="h-9 w-11/12 animate-pulse rounded-md bg-muted/50" />
      </div>
    </aside>
  );
}

// The docked chat column AppShell paints at >=1100px on every page but the chat one. Reserving it
// while the Safe loads keeps the desktop column count identical from first paint to loaded shell.
function PendingAgentRail() {
  return (
    <aside aria-hidden="true" className="hidden w-[440px] min-[1440px]:w-[520px] shrink-0 flex-col border-l border-border min-[1100px]:flex">
      <div className="flex items-center gap-3 border-b border-border p-3">
        <div className="size-9 animate-pulse rounded-full bg-muted/70" />
        <div className="h-4 w-24 animate-pulse rounded bg-muted/50" />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-3 p-3">
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
      </div>
    </aside>
  );
}


const asSafe = (s: { address: string; name: string; networks: number[]; ownedChainIds: number[]; agent: boolean }): Safe => ({
  id: s.address,
  name: s.name || shortAddress(s.address),
  address: s.address,
  threshold: "",
  agent: s.agent,
  networks: s.networks.filter((c) => s.ownedChainIds.includes(c)).map((c) => ({ id: NETWORK_OF[c as keyof typeof NETWORK_OF], deployed: true, agent: s.agent })),
  balances: {},
});

export default function SafeLayout({ children, params }: { children: ReactNode; params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const summary = useSafeSummary(address);
  const { session } = useSession();
  const list = useSafes(session?.address);
  const pathname = usePathname() ?? "";
  const signOut = useSignOut();
  const canUseBaseReserve = !!summary.data?.ownedChainIds?.includes(8453);
  const reserveQuery = useReserve(address, canUseBaseReserve);
  const reserve = canUseBaseReserve ? reserveQuery.data?.status ?? null : null;

  if (summary.error) {
    const from = pathname + (typeof window === "undefined" ? "" : window.location.search);
    const base = describeError(summary.error, "safe", { from, retry: () => void summary.refetch() });
    // A plan link opened by a non-owner: the spec's "needs a different wallet" page, with no plan data.
    if (base.kind === "no-access" && /\/proposals\/[^/]+/.test(pathname)) return <main className="min-h-full"><WrongWallet returnTo={pathname} /></main>;
    // The 403 card keeps its r1 wording.
    const d = base.kind === "no-access"
      ? { ...base, title: "This wallet is not an owner of this Safe", reason: "Only a Safe's owners can open it. Pick another Safe, or connect a wallet that owns this one.", primary: { label: "Pick another Safe", href: "/onboarding" } }
      : base;
    return (
      <div className="flex min-h-full flex-col md:flex-row">
      <PendingSafeRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <MinimalTopBar address={address} onSignOut={() => void signOut()} />
        <main className="flex min-h-0 flex-1 items-center justify-center p-4">
          <StateMessage kind="error" title={d.title} reason={d.reason} action={d.primary} secondary={d.secondary} reassure={d.kind !== "signed-out" && d.kind !== "no-access"} className="text-left" />
        </main>
      </div>
      </div>
    );
  }
  if (!summary.data) return (
    <div className="flex min-h-full flex-col md:flex-row">
      <PendingSafeRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <MinimalTopBar address={address} guide={false} onSignOut={() => void signOut()} />
        <main className="flex min-h-0 flex-1 items-center justify-center p-4"><StateMessage kind="loading" label="Loading this Safe…" /></main>
      </div>
      {pathname.toLowerCase() !== safePaths(address).chat.toLowerCase() && <PendingAgentRail />}
    </div>
  );
  const { safe, ownersDiffer, watching, ownedChainIds } = summary.data;
  const loans = summary.data.loans ?? [];
  // The API also returns resumable setup records for onboarding. A Safe with no live owned network
  // cannot open its overview yet, so keep it out of the dashboard switcher. Partial setups with a
  // genuinely owned network remain accessible.
  const safes = (list.data ?? []).filter((s) => s.address.toLowerCase() !== safe.address.toLowerCase() && s.ownedChainIds.length > 0).map(asSafe);
  return (
    <ShellProvider lastCheckAt={summary.data.monitorLastCheckAt} firstCheckDue={summary.data.monitorFirstCheckDue} safe={safe} safes={[safe, ...safes]} loans={loans} loansError={summary.data.loans === null} chainIds={summary.data.chainIds} agentOn={safe.networks.some((n) => n.agent)} watching={watching} failing={summary.data.monitorFailing} starting={summary.data.monitorStarting} reserve={reserve} walletAddress={session?.address}>
      <OwnedChainsProvider value={ownedChainIds}>
      <AppShell userLabel={session ? shortAddress(session.address) : undefined} userAddress={session?.address} ownedChainIds={ownedChainIds} onSignOut={() => void signOut()} chat={(close) => <ChatPanel address={safe.address} onClose={close} />}>
        {ownersDiffer && <p role="status" className="border-b border-border bg-muted p-3 text-xs">{OWNERS_DIFFER_NOTICE}</p>}
        {children}
      </AppShell>
      </OwnedChainsProvider>
    </ShellProvider>
  );
}
