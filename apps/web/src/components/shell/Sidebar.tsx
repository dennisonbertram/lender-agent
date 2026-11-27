"use client";

import Link from "next/link";
import { Activity, AlertTriangle, Banknote, Check, ChevronsUpDown, MessageCircle, LayoutGrid, PiggyBank, Plus, Settings, ShieldCheck } from "lucide-react";
import type { Network, Safe } from "@/lib/types";
import { attentionCounts, attentionLine } from "@/lib/loan-copy";
import { AgentWatchStatus } from "@/components/agent/AgentWatchStatus";
import { pickerLine } from "@/lib/watch-copy";
import { WalletMenu } from "@/components/wallet/WalletMenu";
import { GuideButton } from "@/components/guide/Guide";
import { shortAddress } from "@/lib/address";
import { AddressText } from "@/components/ui/address";
import { SafeIdentity as SharedSafeIdentity } from "@/components/ui/safe-identity";
import type { HealthStatus } from "@/lib/loan-math";
import { cn } from "@/lib/utils";
import { HealthDot, NetworkChip, ReserveStatusChip, statusLabel } from "@/components/common";
import { usd } from "@/lib/format";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { showReserveNav } from "@/components/reserve/reserve-nav";
import { useSafeNickname, type ShellLoan, type ShellReserve } from "./ShellContext";

/** Routes of one Safe (see FLEET_CONVENTIONS.md). */
export const safePaths = (address: string) => ({
  overview: `/s/${address}`,
  chat: `/s/${address}/chat`,
  getCash: `/s/${address}/get-cash`,
  activity: `/s/${address}/activity`,
  reserve: `/s/${address}/reserve`,
  settings: `/s/${address}/settings`,
  loan: (id: string) => `/s/${address}/loans/${id}`,
});

/** Navigation items of the sidebar, in order. */
export const navItems = (address: string) => {
  const p = safePaths(address);
  return [
    { key: "chat", label: "Ask the agent", href: p.chat, icon: MessageCircle },
    { key: "getCash", label: "Get cash", href: p.getCash, icon: Banknote },
    { key: "overview", label: "Overview", href: p.overview, icon: LayoutGrid },
  ] as const;
};

function Item({ href, active, children }: { href: string; active?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 pointer-coarse:min-h-11 text-left text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70",
        active && "bg-sidebar-accent font-medium",
      )}
    >
      {children}
    </Link>
  );
}

function SafeRow({ name, address, status, tone, agent, networks }: { name: string; address: string; status?: string; tone?: "act" | "watch" | "ok"; agent?: boolean; networks?: Network[] }) {
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background [&_*]:text-background!"><ShieldCheck className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {shortAddress(address) !== name && <span className="block truncate text-xs text-muted-foreground">{shortAddress(address)}</span>}
        {networks && <span className="mt-0.5 flex flex-wrap gap-1">{networks.map((n) => <NetworkChip key={n} id={n} className="px-1.5 py-0" />)}</span>}
        {status && (tone === "ok"
          ? <AgentWatchStatus variant="row" state={agent ? "watching" : "off"} line={status} />
          : <span className={cn("block truncate text-xs", tone === "act" ? "text-destructive-text!" : "text-warning-text!")}>{status}</span>)}
      </span>
    </>
  );
}

export type SafePickerProps = {
  safe: Safe;
  safes: Safe[];
  /** Health of each Safe's loans, by Safe id, for the status line under its name. */
  statusesBySafe?: Record<string, HealthStatus[]>;
  compact?: boolean;
  /** Chain of the current Safe, for the address links in the open menu. */
  chainId?: number;
  /** Called with the href when a Safe is picked or "Add a Safe" is chosen. The caller navigates (links in the sidebar navigate themselves). */
  onNavigate: (href: string) => void;
};

/** Switching a Safe lands on its Overview. */
export function SafePicker({ safe, safes, statusesBySafe = {}, compact, chainId, onNavigate }: SafePickerProps) {
  const { safeName } = useSafeNickname();
  const currentName = safeName(safe.address, safe.name);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={compact ? `Switch Safe, current: ${currentName}` : undefined}
        className={compact
          ? "flex h-9 pointer-coarse:h-11 min-w-0 flex-1 items-center justify-start gap-1.5 rounded-lg px-2.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          : "flex w-full items-center gap-2 rounded-xl bg-sidebar-accent p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"}
      >
        {compact ? <span className="truncate">{currentName}</span> : <SafeRow name={currentName} address={safe.address} />}
        <ChevronsUpDown className={cn("size-3.5 shrink-0 text-muted-foreground", compact ? "" : "ml-auto")} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-64">
        <div className="px-2 py-1.5 text-xs">
          <div className="text-muted-foreground">Safe address</div>
          <AddressText address={safe.address} chainId={chainId} showSafeApp />
        </div>
        <DropdownMenuSeparator />
        {safes.map((x) => {
          const st = statusesBySafe[x.id] ?? [];
          const { act, watch } = attentionCounts(st);
          return (
            <DropdownMenuItem key={x.id} onClick={() => onNavigate(safePaths(x.address).overview)} className="gap-2 py-2">
              <SafeRow name={safeName(x.address, x.name)} address={x.address} networks={x.networks.map((n) => n.id)} status={x.id === safe.id ? pickerLine(st, x.agent) : undefined} agent={x.agent} tone={act ? "act" : watch ? "watch" : "ok"} />
              {x.id === safe.id && <Check className="size-4" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onNavigate("/onboarding")} className="gap-2 py-2"><Plus /> Add a Safe</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type SidebarProps = SafePickerProps & {
  loans: ShellLoan[];
  /** The loan read failed: say so instead of showing an empty list. */
  loansError?: boolean;
  /** The current path, to mark the active item. */
  pathname: string;
  /** Short name of the signed-in user (an address or ENS name), shown at the bottom. */
  userLabel?: string;
  /** The signed-in address, to tell when the connected wallet is a different one. */
  userAddress?: string;
  /** The Reserve's status; the item shows it when linked and "Set up reserve" otherwise. */
  reserve?: ShellReserve | null;
  /** Chain ids where the Safe is set up and owned by the signed-in user: the wallet menu sends only there. */
  ownedChainIds?: readonly number[];
  /** Signs the user out; the Sign out button shows only with this. */
  onSignOut?: () => void;
};

/** The current Safe's network and address under the picker: the shared identity row, compact. */
export function SafeIdentity({ safe, chainId }: { safe: Safe; chainId?: number }) {
  return <SharedSafeIdentity safe={safe} chainId={chainId} compact />;
}

export function Sidebar({ safe, safes, statusesBySafe, chainId, loans, loansError, pathname, onNavigate, userLabel, userAddress, reserve, ownedChainIds, onSignOut }: SidebarProps) {
  const p = safePaths(safe.address);
  const statuses = loans.map((l) => l.status);
  const { act } = attentionCounts(statuses);
  const line = attentionLine(statuses);
  const worst = loans.length ? loans.reduce((w, l) => ((l.hf ?? Infinity) < (w.hf ?? Infinity) ? l : w)) : undefined;
  // Links use ":" in loan ids where the browser's path may say "%3A": compare decoded.
  const norm = (x: string) => { try { return decodeURIComponent(x).toLowerCase(); } catch { return x.toLowerCase(); } };
  const at = (href: string) => norm(pathname) === norm(href);
  return (
    <div data-sidebar className="rk-scroll flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-sidebar p-3 text-sidebar-foreground">
      <div className="shrink-0"><SafePicker safe={safe} safes={safes} statusesBySafe={statusesBySafe} chainId={chainId} onNavigate={onNavigate} /></div>

      {navItems(safe.address).map(({ key, label, href, icon: Icon }) => (
        <Item key={key} href={href} active={at(href)}><Icon className="size-4" /> {label}</Item>
      ))}

      <div className="-mx-1 flex min-h-28 flex-1 shrink-0 flex-col gap-1 px-1">
        {loansError && <div role="status" className="px-2.5 py-1 text-xs text-warning-text">Couldn't load loans — retrying</div>}
        {loans.length > 0 && <div className="px-2.5 pt-1 text-xs text-muted-foreground">Loans</div>}
        {line && worst && (
          <Link href={p.loan(worst.id)} aria-label={`${line}, open ${worst.venue} loan`} className={cn("flex items-center px-2.5 py-1 text-left text-xs hover:underline pointer-coarse:min-h-11", act ? "text-destructive-text" : "text-warning-text")}>
            {line}
          </Link>
        )}
        {loans.map((l) => (
          <Item key={l.id} href={p.loan(l.id)} active={at(p.loan(l.id))}>
            <HealthDot s={l.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{l.venue}</span>
              <span className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">{l.collAsset} · {l.debtAsset} · <NetworkChip id={l.network} className="border-0 px-0 py-0" /></span>
            </span>
            {l.status === "liquidatable"
              ? <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-destructive-text"><AlertTriangle className="size-3.5" aria-hidden /><span className="sr-only">Can be liquidated</span>{l.hf === null ? "No debt" : l.hf.toFixed(2)}</span>
              : <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{l.hf === null ? "No debt" : `${statusLabel[l.status]} ${l.hf.toFixed(2)}`}</span>}
          </Item>
        ))}
      </div>

      <div className="flex shrink-0 flex-col gap-1">
        {showReserveNav(loans, reserve) && <Item href={p.reserve} active={at(p.reserve)}>
          <PiggyBank className="size-4" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">Reserve</span>
            <span className="block truncate text-xs text-muted-foreground">{reserve ? usd(reserve.balanceUsd) : "Set up reserve"}</span>
          </span>
          {reserve && <ReserveStatusChip s={reserve} />}
        </Item>}
        <Item href={p.activity} active={at(p.activity)}><Activity className="size-4" /> Activity</Item>
        <Item href={p.settings} active={at(p.settings)}><Settings className="size-4" /> Settings</Item>
        {userLabel && <WalletMenu userLabel={userLabel} userAddress={userAddress} safe={safe.address} chainId={chainId} ownedChainIds={ownedChainIds} onSignOut={onSignOut} />}
        <GuideButton />
      </div>
    </div>
  );
}
