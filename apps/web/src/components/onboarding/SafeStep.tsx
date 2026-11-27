"use client";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { NetworkChip } from "@/components/common";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AddressText } from "@/components/ui/address";
import { formatAddress } from "@/lib/explorer";
import { usd } from "@/lib/format";
import { approvalsSummary } from "@/lib/owners";
import { safeNetworkName } from "@/lib/safe-create";
import { CHAIN_NAME, type ChainId } from "@/shared/types";
import { AddSafeForm } from "./AddSafeForm";

export type FoundSafeCard = { address: string; name?: string; threshold: number; ownerCount: number; chainIds: number[]; discoveredChainIds?: number[];
  balanceChainIds?: number[];
  networkDetails?: { chainId: ChainId; threshold: number; ownerCount: number; owners: { address: string; ens?: string }[] }[];
  /** Total value in dollars; absent when it could not be read. */
  balanceUsd?: number;
  assets?: { symbol: string; amount: number }[];
  owners?: { address: string; ens?: string }[];
};

/** A Safe the user saved before, offered again when the wallet lookup found nothing new. `pendingSetup` means its in-app creation is not usable yet; `pendingChainIds` are the recorded networks still not deployed (empty when only indexing is behind). */
export type KnownSafeCard = { address: string; name?: string; pendingSetup?: boolean; chainIds?: number[]; pendingChainIds?: number[]; availableChainIds?: number[]; openSafeChainIds?: number[]; discovery?: FoundSafeCard };

const SHOWN_OWNERS = 3;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const amountText = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 }).format(n);

/** The Safe's signers: ENS name or short address, "You" for the signed-in wallet, the rest behind "and N more". Expanded, each is an address with copy and explorer link. */
function Signers({ owners, wallet, chainId }: { owners: { address: string; ens?: string }[]; wallet?: string; chainId?: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? owners : owners.slice(0, SHOWN_OWNERS);
  const more = owners.length - shown.length;
  const you = (a: string) => !!wallet && same(a, wallet);
  return (
    <span className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span>Signers:</span>
        {!open && shown.map((o) => (
          <span key={o.address} className={you(o.address) ? "font-medium text-foreground" : undefined}>
            {you(o.address) ? "You" : o.ens || formatAddress(o.address)}
          </span>
        ))}
        {!open && more > 0 && <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(true)}>and {more} more</button>}
        {!open && more === 0 && <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(true)}>Show addresses</button>}
        {open && <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(false)}>Hide addresses</button>}
      </span>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {shown.map((o) => (
            <li key={o.address} className="flex flex-wrap items-center gap-x-1.5">
              {(you(o.address) || o.ens) && <span className={you(o.address) ? "font-medium text-foreground" : undefined}>{you(o.address) ? "You" : o.ens}</span>}
              <AddressText address={o.address} chainId={chainId} />
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

const isTestnet = (c: number) => c === 84532;
const chainChipId = (c: number) => {
  const name = CHAIN_NAME[c as ChainId] ?? safeNetworkName(c);
  return isTestnet(c) ? `${name} (test)` : name;
};

/** The account's technical identities — its address and its signers — grouped behind one toggle; copy, explorer and verify stay on demand. */
function CardDetails({ address, chainId, owners, wallet, label = "Address and signers" }: { address: string; chainId?: number; owners?: { address: string; ens?: string }[]; wallet?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="flex flex-col gap-1 text-xs">
      <button type="button" aria-expanded={open} className="w-fit text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <span className="flex flex-col gap-1">
          <AddressText address={address} chainId={chainId} />
          {owners && owners.length > 0 && <Signers owners={owners} wallet={wallet} chainId={chainId} />}
        </span>
      )}
    </span>
  );
}

function approvalLabel(safe: FoundSafeCard | undefined, verifiedChainIds: number[], selectedChainId?: number | null) {
  const networkDetails = safe?.networkDetails;
  const chainId = resolveDetailsChainId(safe, verifiedChainIds, selectedChainId);
  const snapshot = chainId === undefined ? undefined : networkDetails?.find((network) => network.chainId === chainId);
  const legacyFirst = safe && (!networkDetails || networkDetails.length === 0) && chainId === safe.chainIds[0] ? safe : undefined;
  const threshold = snapshot?.threshold ?? legacyFirst?.threshold;
  const ownerCount = snapshot?.ownerCount ?? legacyFirst?.ownerCount;
  const name = chainId === undefined ? undefined : chainChipId(chainId);
  if (threshold === undefined || ownerCount === undefined) return `Approval details unavailable${name ? ` on ${name}` : " until a network is verified"}.`;
  const summary = ownerCount === 1 ? approvalsSummary(1, 1) : `${threshold} of ${ownerCount} owners must approve each transaction`;
  return verifiedChainIds.length > 1 ? `Approvals on ${name ?? "the selected network"}: ${summary}` : summary;
}

function resolveDetailsChainId(safe: FoundSafeCard | undefined, verifiedChainIds: number[], selectedChainId?: number | null) {
  if (selectedChainId !== null && selectedChainId !== undefined && verifiedChainIds.includes(selectedChainId)) return selectedChainId;
  return safe?.networkDetails?.find((network) => verifiedChainIds.includes(network.chainId))?.chainId
    ?? (safe?.chainIds.find((id) => verifiedChainIds.includes(id)))
    ?? verifiedChainIds[0];
}

function hasCompleteBalanceCoverage(safe: FoundSafeCard) {
  const balanceChainIds = safe.balanceChainIds ?? safe.chainIds;
  return safe.chainIds.every((id) => balanceChainIds.includes(id));
}

/** Shows network membership separately from the exact approval/signer snapshot and balance coverage. */
function SafeNetworkInfo({ address, safe, verifiedChainIds, selectedChainId, wallet, showApproval = true, showBalanceAmount = false }: {
  address: string;
  safe?: FoundSafeCard;
  verifiedChainIds: number[];
  selectedChainId?: number | null;
  wallet?: string;
  showApproval?: boolean;
  showBalanceAmount?: boolean;
}) {
  const networkDetails = safe?.networkDetails;
  const detailChainId = resolveDetailsChainId(safe, verifiedChainIds, selectedChainId);
  const snapshot = detailChainId === undefined ? undefined : networkDetails?.find((network) => network.chainId === detailChainId);
  // Older single-network responses can use their original fields. For multi-network responses, those fields only
  // describe the first discovery network and are never used as a different network's approval policy.
  const legacyFirst = safe && (!networkDetails || networkDetails.length === 0) && detailChainId === safe.chainIds[0] ? safe : undefined;
  const owners = snapshot?.owners ?? legacyFirst?.owners;
  const name = detailChainId === undefined ? undefined : chainChipId(detailChainId);
  const oneNetwork = verifiedChainIds.length <= 1;
  const balanceChainIds = safe ? safe.balanceChainIds ?? safe.chainIds : [];
  const hasDistinctBalanceCoverage = safe && verifiedChainIds.length > 1;
  const filterDoesNotMatch = selectedChainId !== null && selectedChainId !== undefined && !verifiedChainIds.includes(selectedChainId);
  const detailsLabel = !name ? "Address" : !oneNetwork || filterDoesNotMatch
    ? owners ? `Address and signers on ${name}` : `Address on ${name}`
    : "Address and signers";
  return (
    <div className="flex flex-col gap-1.5">
      {verifiedChainIds.length > 0 ? (
        <span className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          <span>Verified ownership on{" "}</span>{verifiedChainIds.map((id, index) => <span key={id} className="inline-flex items-center gap-1">{index > 0 && " and "}<NetworkChip id={chainChipId(id)} className="px-1.5 py-0" /></span>)}
        </span>
      ) : <span className="text-xs text-muted-foreground">Network unavailable.</span>}
      {showApproval && <span className="text-xs text-muted-foreground">{approvalLabel(safe, verifiedChainIds, selectedChainId)}</span>}
      {(showBalanceAmount || hasDistinctBalanceCoverage) && safe?.balanceUsd !== undefined && balanceChainIds.length > 0 && <span className="text-xs text-muted-foreground">
        {showBalanceAmount
          ? hasCompleteBalanceCoverage(safe)
            ? `${usd(safe.balanceUsd)} ${balanceChainIds.length === 1 ? "on" : "across"} ${balanceChainIds.map(chainChipId).join(" and ")}`
            : `${usd(safe.balanceUsd)} found on ${balanceChainIds.map(chainChipId).join(" and ")}. Other balances are unavailable.`
          : `Total across ${balanceChainIds.map(chainChipId).join(" and ")}`}
      </span>}
      <CardDetails address={address} chainId={detailChainId} owners={owners} wallet={wallet} label={detailsLabel} />
    </div>
  );
}

/** The Safe step of the found path (r31). */
export function SafeStep({ wallet, found, known, loading, savedLoading, savedLookupFailed, createDisabled, lookupFailed, existing, busy, error, onPick, onAdd, onCreate, onRetry, onResume, onUseAnotherWallet }: {
  /** The signed-in wallet: marked "You" among the signers. */
  wallet?: string;
  found: FoundSafeCard[];
  /** Safes saved earlier: still offered when the wallet lookup fails or finds nothing new. */
  known?: KnownSafeCard[];
  loading?: boolean;
  /** The user's saved Safe list is being checked independently of wallet discovery. */
  savedLoading?: boolean;
  /** The saved Safe list failed; an empty result is not known yet. */
  savedLookupFailed?: boolean;
  /** Do not offer new Safe creation until the saved list has loaded. */
  createDisabled?: boolean;
  /** The lookup of the wallet's Safes failed: do not claim there are none. */
  lookupFailed?: boolean;
  /** Addresses the user already added. */
  existing: string[];
  busy?: boolean;
  error?: string | null;
  onPick: (address: string) => void;
  onAdd: (v: { address: string; name: string }) => void;
  /** Start the Create a Safe flow (E7). */
  onCreate?: () => void;
  /** Run the wallet lookup again after it failed. */
  onRetry?: () => void;
  /** Continue the in-app creation of a saved Safe whose setup never finished. */
  onResume?: (address: string) => void;
  /** Sign out so another wallet can be used. */
  onUseAnotherWallet?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [networkFilter, setNetworkFilter] = useState<number | null>(null);
  const none = !loading && found.length === 0;
  const savedBusy = !!savedLoading;
  const savedFailed = !!savedLookupFailed;
  const empty = none && !lookupFailed && !savedBusy && !savedFailed && (known?.length ?? 0) === 0;
  // Funded Safes first; the rest keep their order.
  const sorted = [...found].sort((x, y) => Number((y.balanceUsd ?? 0) > 0) - Number((x.balanceUsd ?? 0) > 0));
  const networks = [...new Set([
    ...found.flatMap((safe) => safe.chainIds),
    ...(known ?? []).flatMap((safe) => safe.pendingSetup ? safe.availableChainIds ?? [] : safe.chainIds ?? []),
  ])];
  const pendingAddresses = new Set((known ?? []).filter((safe) => safe.pendingSetup).map((safe) => safe.address.toLowerCase()));
  const visibleFound = sorted.filter((safe) => !pendingAddresses.has(safe.address.toLowerCase()) && (networkFilter === null || safe.chainIds.includes(networkFilter)));
  const foundAddresses = new Set(found.map((safe) => safe.address.toLowerCase()));
  const visibleKnown = (known ?? []).filter((safe) => safe.pendingSetup || !foundAddresses.has(safe.address.toLowerCase()))
    .filter((safe) => safe.pendingSetup || networkFilter === null || !!safe.chainIds?.includes(networkFilter));
  const hasUnknownNetwork = sorted.some((safe) => safe.chainIds.length === 0)
    || (known ?? []).some((safe) => !safe.pendingSetup && !safe.chainIds?.length && !foundAddresses.has(safe.address.toLowerCase()));
  const hasPendingSetup = visibleKnown.some((safe) => safe.pendingSetup);
  return (
    <>
      <h1 tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">{hasPendingSetup ? "Finish setting up your Safe" : visibleFound.length > 0 ? "Choose a Safe" : "Your Safe"}</h1>
      {visibleFound.length > 0 && !adding && <p className="text-xs text-muted-foreground">Choose the Safe the Lender agent should work with.</p>}
      {empty && (
        <p className="text-sm">
          {wallet ? <>No Safe found for <AddressText address={wallet} />. </> : "No Safe found for this wallet. "}
          Is this the wallet you use for your Safe? If not, use another wallet. You can also create a new Safe or add one you own by its address.
        </p>
      )}
      {lookupFailed && !adding && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">We could not look up your Safes. Try again, or use one you saved before.</p>
          {onRetry && <Button size="lg" variant="outline" disabled={busy} onClick={onRetry}>Retry</Button>}
        </div>
      )}
      {savedBusy && !adding && <p role="status" className="text-xs text-muted-foreground">Checking your saved Safes…</p>}
      {savedFailed && !adding && !lookupFailed && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">We could not load your saved Safes. Retry to check for a setup you can continue.</p>
          {onRetry && <Button size="lg" variant="outline" disabled={busy} onClick={onRetry}>Retry</Button>}
        </div>
      )}
      {loading && <p className="text-xs text-muted-foreground">Looking for your Safes…</p>}
      {!adding && (
        <>
        {(networks.length > 1 || networkFilter !== null) && <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-muted-foreground">Show Safes on</legend>
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={networkFilter === null} className={cn("inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", networkFilter === null ? "border-primary bg-primary text-primary-foreground shadow-sm" : "border-border bg-background/40 text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground")} onClick={() => setNetworkFilter(null)}><NetworkChip id="All networks" className="rounded-none border-0 px-0 py-0 text-current" /></button>
            {networks.map((network) => <button key={network} type="button" aria-pressed={networkFilter === network} className={cn("inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", networkFilter === network ? "border-primary bg-primary text-primary-foreground shadow-sm" : "border-border bg-background/40 text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground")} onClick={() => setNetworkFilter(network)}><NetworkChip id={chainChipId(network)} className="rounded-none border-0 px-0 py-0 text-current" /></button>)}
          </div>
        </fieldset>}
        {networkFilter !== null && visibleFound.length === 0 && visibleKnown.length === 0 && <p className="text-sm">{hasUnknownNetwork
          ? <>No Safes with reported network information found on {chainChipId(networkFilter)}. Choose All networks to review Safes whose network is unavailable.</>
          : <>No Safes found on {chainChipId(networkFilter)}.</>}</p>}
        <ul className="flex flex-col gap-2" data-guide-target={visibleFound.length > 0 ? "choose-safe" : undefined}>
          {visibleFound.map((s) => (
            <li key={s.address} className="flex flex-col gap-1.5 rounded-xl p-3 ring-1 ring-foreground/10 hover:bg-muted/50">
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(s.address)}
                className="flex w-full flex-col gap-1.5 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="text-sm font-medium">{s.name || (s.balanceUsd && hasCompleteBalanceCoverage(s) ? `${usd(s.balanceUsd)} Safe` : "Safe")}</span>
                {s.balanceUsd !== undefined && (
                  !hasCompleteBalanceCoverage(s) ? (
                    <span className="text-sm text-muted-foreground">
                      {usd(s.balanceUsd)} found on {s.balanceChainIds?.length ? s.balanceChainIds.map(chainChipId).join(" and ") : "the reported networks"}. Other balances are unavailable.
                    </span>
                  ) : s.balanceUsd === 0 ? (
                    <span className="text-sm text-warning-text">Empty. Add funds before borrowing.</span>
                  ) : (
                    <span className="text-sm">
                      {s.name && <span className="font-medium">{usd(s.balanceUsd)}</span>}
                      {s.assets && s.assets.length > 0 && <> <span className="text-xs text-muted-foreground">{s.assets.map((a) => `${amountText(a.amount)} ${a.symbol}`).join(" · ")}</span></>}
                    </span>
                  )
                )}
                <span className="text-xs text-muted-foreground">{approvalLabel(s, s.chainIds, networkFilter)}</span>
                <span className="flex items-center gap-1 text-xs font-medium">Open Safe <ChevronRight aria-hidden className="size-3.5" /></span>
              </button>
              <SafeNetworkInfo address={s.address} safe={s} verifiedChainIds={s.chainIds} selectedChainId={networkFilter} wallet={wallet} showApproval={false} />
            </li>
          ))}
        </ul>
        </>
      )}
      {!adding && visibleKnown.length > 0 && (
        <ul aria-label="Saved Safes" className="flex flex-col gap-2" data-guide-target="choose-safe">
          {visibleKnown.map((k) => (
            <li key={k.address} className="flex flex-col gap-1.5 rounded-xl p-3 ring-1 ring-foreground/10 hover:bg-muted/50">
              {k.pendingSetup ? (() => {
                const pending = k.pendingChainIds ?? k.chainIds ?? [];
                const done = (k.chainIds ?? []).filter((c) => !pending.includes(c));
                return (
                <>
                  <span className="text-sm font-medium">{k.name || "Safe"}</span>
                  {networkFilter !== null && !k.availableChainIds?.includes(networkFilter) && <span className="text-xs text-muted-foreground">Setup recovery is shown even though this Safe does not match the selected network.</span>}
                  <span className="text-xs text-muted-foreground">
                    {pending.length > 0
                      ? <>Setup not finished{done.length > 0 && <> — done on {done.map(chainChipId).join(", ")}</>} — finish on {pending.map(chainChipId).join(", ")}. Nothing is paid again.</>
                      : "Setup not finished — the Safe service has not listed it yet. Nothing is paid again."}
                  </span>
                  <Button size="lg" disabled={busy} onClick={() => onResume?.(k.address)}>Finish setting up</Button>
                  <SafeNetworkInfo address={k.address} safe={k.discovery} verifiedChainIds={k.availableChainIds ?? []} selectedChainId={networkFilter} wallet={wallet} showBalanceAmount />
                  {k.openSafeChainIds && k.openSafeChainIds.length > 0 && <Button size="lg" variant="outline" disabled={busy} onClick={() => onPick(k.address)}>
                    Open Safe
                  </Button>}
                </>
                );
              })() : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(k.address)}
                  className="flex w-full flex-col gap-1.5 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="text-sm font-medium">{k.name || "Safe"}</span>
                  <span className="text-xs text-muted-foreground">Saved — your wallet is checked again when you open it.</span>
                  <span className="flex items-center gap-1 text-xs font-medium">Open Safe <ChevronRight aria-hidden className="size-3.5" /></span>
                </button>
              )}
              {!k.pendingSetup && <SafeNetworkInfo address={k.address} verifiedChainIds={k.availableChainIds ?? k.chainIds ?? []} selectedChainId={networkFilter} wallet={wallet} />}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <AddSafeForm existing={existing} busy={busy} serverError={error} onSubmit={onAdd} onCancel={() => setAdding(false)} />
      ) : visibleFound.length > 0 ? (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm text-muted-foreground">Other options</summary>
          <div className="mt-2 flex flex-col gap-2">
            {onCreate && <Button size="lg" variant="outline" disabled={createDisabled} onClick={onCreate}>Create a new Safe</Button>}
            <Button size="lg" variant="outline" onClick={() => setAdding(true)}>Add by address</Button>
          </div>
        </details>
      ) : (
        <div className="flex flex-col gap-2">
          {empty && onUseAnotherWallet && <Button size="lg" onClick={onUseAnotherWallet}>Use another wallet</Button>}
          {onCreate && <Button size="lg" disabled={createDisabled} variant={none && !(empty && onUseAnotherWallet) ? "default" : "outline"} onClick={onCreate}>Create a new Safe</Button>}
          <Button size="lg" variant="outline" onClick={() => setAdding(true)}>Add by address</Button>
        </div>
      )}
      {!adding && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </>
  );
}
