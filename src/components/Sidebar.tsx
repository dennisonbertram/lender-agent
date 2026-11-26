import { Activity, AlertTriangle, Check, ChevronsUpDown, LayoutGrid, Banknote, MessageCircle, Plus, Settings, ShieldCheck, PiggyBank } from "lucide-react";
import { PRICES, USER, loanHF, networkName, usd, type Asset, type Network, type Stable } from "@/data";
import { useApp, useAttention, useStatus } from "@/store";
import { attentionCounts, attentionLine, safeStatusLine } from "@/lib/loan-copy";
import { cn } from "@/lib/utils";
import { HealthDot, NetworkChip, ReserveStatusChip, statusLabel } from "@/components/common";
import { reserveStatus } from "@/lib/reserve";
import { shortAddress } from "@/lib/address";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

function Item({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 pointer-coarse:min-h-11 text-left text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70",
        active && "bg-sidebar-accent font-medium",
      )}
    >
      {children}
    </button>
  );
}

function SafeRow({ name, address, status, tone, networks }: { name: string; address: string; status?: string; tone?: "act" | "watch" | "ok"; networks?: Network[] }) {
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background [&_*]:text-background!"><ShieldCheck className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{shortAddress(address)}</span>
        {networks && <span className="mt-0.5 flex flex-wrap gap-1">{networks.map((n) => <NetworkChip key={n} id={n} className="px-1.5 py-0" />)}</span>}
        {status && <span className={cn("block truncate text-xs", tone === "act" ? "text-destructive-text!" : tone === "watch" ? "text-warning-text!" : "text-muted-foreground!")}>{status}</span>}
      </span>
    </>
  );
}

export function SafePicker({ compact }: { compact?: boolean }) {
  const { allLoans, safes, safe, switchSafe, setAddSafeOpen } = useApp();
  const status = useStatus();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={compact ? `Switch Safe, current: ${safe.name}` : undefined}
        className={compact
          ? "flex h-9 pointer-coarse:h-11 min-w-0 flex-1 items-center justify-start gap-1.5 rounded-lg px-2.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          : "flex w-full items-center gap-2 rounded-xl bg-sidebar-accent p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"}
      >
        {compact ? <span className="truncate">{safe.name}</span> : <SafeRow name={safe.name} address={safe.address} />}
        <ChevronsUpDown className={cn("size-3.5 shrink-0 text-muted-foreground", compact ? "" : "ml-auto")} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-64">
        {safes.map((x) => {
          const st = allLoans.filter((l) => l.safeId === x.id).map(status);
          const { act, watch } = attentionCounts(st);
          return (
            <DropdownMenuItem key={x.id} onClick={() => switchSafe(x.id)} className="gap-2 py-2">
              <SafeRow name={x.name} address={x.address} networks={x.networks.map((n) => n.id)} status={safeStatusLine(st, x.agent)} tone={act ? "act" : watch ? "watch" : "ok"} />
              {x.id === safe.id && <Check className="size-4" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setAddSafeOpen(true)} className="gap-2 py-2"><Plus /> Add a Safe</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar() {
  const { view, go, loans, reserveLinked, reserveBal, policy } = useApp();
  const reserveUsd = (Object.keys(reserveBal) as (Asset | Stable)[]).reduce((t, a) => t + reserveBal[a] * PRICES[a], 0);
  const status = useStatus();
  const statuses = loans.map(status);
  const { act } = attentionCounts(statuses);
  const { worst } = useAttention();
  const line = attentionLine(statuses);
  return (
    <div data-sidebar className="flex h-full min-h-0 flex-col gap-3 bg-sidebar p-3 text-sidebar-foreground">
      <SafePicker />

      <Item active={view.name === "chat"} onClick={() => go({ name: "chat" })}>
        <MessageCircle className="size-4" /> Ask the agent
      </Item>
      <Item active={view.name === "home"} onClick={() => go({ name: "home" })}>
        <LayoutGrid className="size-4" /> Overview
      </Item>
      <Item active={view.name === "cash"} onClick={() => go({ name: "cash" })}>
        <Banknote className="size-4" /> Get cash
      </Item>

      <div className="rk-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
        {loans.length > 0 && <div className="px-2.5 pt-1 text-xs text-muted-foreground">Loans</div>}
        {line && worst && (
          <button onClick={() => go({ name: "loan", id: worst.id })} aria-label={`${line}, open ${worst.venue} loan`} className={cn("flex items-center px-2.5 py-1 text-left text-xs hover:underline pointer-coarse:min-h-11", act ? "text-destructive-text" : "text-warning-text")}>
            {line}
          </button>
        )}
        {loans.map((l) => (
          <Item key={l.id} active={view.name === "loan" && view.id === l.id} onClick={() => go({ name: "loan", id: l.id })}>
            <HealthDot s={status(l)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{l.venue}</span>
              <span className="block text-xs text-muted-foreground">{l.collAsset} · {l.debtAsset} · {networkName(l.network)}</span>
            </span>
            {status(l) === "liquidatable"
              ? <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-destructive-text"><AlertTriangle className="size-3.5" aria-hidden /><span className="sr-only">Can be liquidated</span>{loanHF(l).toFixed(2)}</span>
              : <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{statusLabel[status(l)]} {loanHF(l).toFixed(2)}</span>}
          </Item>
        ))}
        <div className="mx-2.5 my-1 border-t border-sidebar-border" />
        <Item active={view.name === "reserve"} onClick={() => go({ name: "reserve" })}>
          <PiggyBank className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">Reserve</span>
            <span className="block truncate text-xs text-muted-foreground">{reserveLinked ? usd(reserveUsd) : "Set up reserve"}</span>
          </span>
          {reserveLinked && (
            <ReserveStatusChip s={reserveStatus(policy, Date.now())} />
          )}
        </Item>
      </div>

      <div className="flex flex-col gap-1">
        <Item active={view.name === "activity"} onClick={() => go({ name: "activity" })}>
          <Activity className="size-4" /> Activity
        </Item>
        <Item active={view.name === "settings"} onClick={() => go({ name: "settings" })}>
          <Settings className="size-4" /> Settings
        </Item>
        <div className="flex items-center gap-2 px-2.5 pt-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-sidebar-accent text-xs">{USER.name[0]}</span>
          <span className="text-sm">{USER.name}</span>
          <span className="ml-auto rounded-full border border-sidebar-border px-2 py-0.5 text-xs text-muted-foreground">Sample data</span>
        </div>
      </div>
    </div>
  );
}
