"use client";
import { useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { NetworkChip } from "@/components/common";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AddressText } from "@/components/ui/address";
import { Spinner } from "@/components/ui/spinner";
import { shortAddress } from "@/lib/address";
import { formatAddress } from "@/lib/explorer";
import { usd } from "@/lib/format";
import { approvalsSummary } from "@/lib/owners";
import { safeNetworkName, SERVED_CHAIN_IDS } from "@/lib/safe-create";
import { CHAIN_NAME, type ChainId } from "@/shared/types";
import { GuideIntro } from "@/components/guide/Guide";
import { AddSafeForm } from "./AddSafeForm";

export type FoundSafeCard = { address: string; name?: string; threshold: number; ownerCount: number; chainIds: number[]; discoveredChainIds?: number[];
  balanceChainIds?: number[];
  networkDetails?: { chainId: ChainId; threshold: number; ownerCount: number; owners: { address: string; ens?: string }[] }[];
  /** Total value in dollars; absent when it could not be read. */
  balanceUsd?: number;
  assets?: { symbol: string; amount: number }[];
  owners?: { address: string; ens?: string }[];
};
type NetworkFreshness = Record<number, "fresh" | "stale" | "unavailable">;

/** A Safe the user saved before, offered again when the wallet lookup found nothing new. `pendingSetup` means its in-app creation is not usable yet; `pendingChainIds` are the recorded networks still not deployed (empty when only indexing is behind). */
export type KnownSafeCard = { address: string; name?: string; pendingSetup?: boolean; chainIds?: number[]; pendingChainIds?: number[]; availableChainIds?: number[]; openSafeChainIds?: number[]; discovery?: FoundSafeCard };

const SHOWN_OWNERS = 3;
/** Small text toggles (details disclosures, signer expansion): quiet next to the primary
    action, still readable and visibly focusable. */
const quietToggleClass = "rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
/** Both pick lists: fluid auto-fill tracks of at least ~19rem — four-plus columns at
    1440px, five-plus at 1920px, one on phones — so a lone card keeps its natural size
    instead of stretching and none is squeezed below the track minimum. */
const gridClass = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3 has-[[aria-expanded=true]]:items-start";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const amountText = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 }).format(n);
/** The tile's title: its name, or the short address so identical unnamed Safes stay distinct. */
const safeTitle = (s: { name?: string; address: string }) => s.name || shortAddress(s.address);

/** Every "Open Safe" button names its Safe for assistive tech: the title plus the short
    address — skipped when the title already is that address, so unnamed Safes are not repeated. */
const openSafeLabel = (s: { name?: string; address: string }) =>
  s.name ? `Open Safe ${s.name} ${shortAddress(s.address)}` : `Open Safe ${shortAddress(s.address)}`;

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
          <span key={o.address} className={cn("min-w-0 [overflow-wrap:anywhere]", you(o.address) && "font-medium text-foreground")}>
            {you(o.address) ? "You" : o.ens || formatAddress(o.address)}
          </span>
        ))}
        {!open && more > 0 && <button type="button" className={quietToggleClass} onClick={() => setOpen(true)}>and {more} more</button>}
        {!open && more === 0 && <button type="button" className={quietToggleClass} onClick={() => setOpen(true)}>Show addresses</button>}
        {open && <button type="button" className={quietToggleClass} onClick={() => setOpen(false)}>Hide addresses</button>}
      </span>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {shown.map((o) => (
            <li key={o.address} className="flex flex-wrap items-center gap-x-1.5">
              {(you(o.address) || o.ens) && <span className={cn("min-w-0 [overflow-wrap:anywhere]", you(o.address) && "font-medium text-foreground")}>{you(o.address) ? "You" : o.ens}</span>}
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
      <button type="button" aria-expanded={open} className={cn("inline-flex min-h-8 w-fit items-center text-muted-foreground", quietToggleClass)} onClick={() => setOpen((v) => !v)}>
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

/** The disclosed network snapshot for a card: which chain the details describe and the owners known for it. */
function resolveDetails(safe: FoundSafeCard | undefined, verifiedChainIds: number[], selectedChainId?: number | null) {
  const networkDetails = safe?.networkDetails;
  const detailChainId = resolveDetailsChainId(safe, verifiedChainIds, selectedChainId);
  const snapshot = detailChainId === undefined ? undefined : networkDetails?.find((network) => network.chainId === detailChainId);
  // Older single-network responses can use their original fields — but only when that first discovery
  // network is the one being described. No verified chain means no approval policy is claimed.
  const legacyFirst = safe && (!networkDetails || networkDetails.length === 0) && detailChainId !== undefined && detailChainId === safe.chainIds[0] ? safe : undefined;
  return { detailChainId, owners: snapshot?.owners ?? legacyFirst?.owners };
}

/** What a disclosure truthfully contains beyond the address: signer names, an approval
    policy, or neither — the toggle label must never promise content that is absent. */
type DetailContent = "signers" | "approvals" | "address";

/** The disclosure toggle's label: qualified with the network whenever the details could describe another one. */
function detailsToggleLabel(content: DetailContent, name: string | undefined, verifiedChainIds: number[], selectedChainId?: number | null) {
  const oneNetwork = verifiedChainIds.length <= 1;
  const filterDoesNotMatch = selectedChainId !== null && selectedChainId !== undefined && !verifiedChainIds.includes(selectedChainId);
  const base = content === "signers" ? "Address and signers" : content === "approvals" ? "Address and approvals" : "Address";
  return !name ? "Address" : !oneNetwork || filterDoesNotMatch ? `${base} on ${name}` : base;
}

/** The approval snapshot a disclosure can claim: the resolved per-network detail, or the
    legacy single-network fields only when they describe that same first chain — so no
    verified chain never borrows the top-level fields to invent a policy. */
function resolveApprovalSnapshot(safe: FoundSafeCard | undefined, verifiedChainIds: number[], selectedChainId?: number | null) {
  const networkDetails = safe?.networkDetails;
  const chainId = resolveDetailsChainId(safe, verifiedChainIds, selectedChainId);
  const snapshot = chainId === undefined ? undefined : networkDetails?.find((network) => network.chainId === chainId);
  const legacyFirst = safe && (!networkDetails || networkDetails.length === 0) && chainId !== undefined && chainId === safe.chainIds[0] ? safe : undefined;
  return { chainId, threshold: snapshot?.threshold ?? legacyFirst?.threshold, ownerCount: snapshot?.ownerCount ?? legacyFirst?.ownerCount };
}

function approvalLabel(safe: FoundSafeCard | undefined, verifiedChainIds: number[], selectedChainId?: number | null, qualifyNetwork = false) {
  const { chainId, threshold, ownerCount } = resolveApprovalSnapshot(safe, verifiedChainIds, selectedChainId);
  const name = chainId === undefined ? undefined : chainChipId(chainId);
  if (threshold === undefined || ownerCount === undefined) return `Approval details unavailable${name ? ` on ${name}` : " until a network is verified"}.`;
  const summary = ownerCount === 1 ? approvalsSummary(1, 1) : `${threshold} of ${ownerCount} owners must approve each transaction`;
  return verifiedChainIds.length > 1 || qualifyNetwork ? `Approvals on ${name ?? "the selected network"}: ${summary}` : summary;
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

function supportedBalanceAmount(value: number) {
  if (value > 0 && value < 0.01) return "under $0.01";
  return usd(value, value > 0 && value < 1 ? 2 : 0);
}

function supportedBalanceDetails(safe: FoundSafeCard, discoveryComplete = true) {
  if (safe.balanceUsd === undefined) return "Balance unavailable";
  const balanceChainIds = safe.balanceChainIds ?? safe.chainIds;
  const networks = balanceChainIds.map(chainChipId).join(" and ");
  const complete = discoveryComplete && hasCompleteBalanceCoverage(safe);
  const hasPositiveAsset = safe.assets?.some((asset) => asset.amount > 0) ?? false;
  if (safe.balanceUsd === 0 && !hasPositiveAsset && complete) return "No supported funds found.";
  if (!complete) return `found on ${networks || "the reported networks"}. ${discoveryComplete ? "Other balances are unavailable." : "Other networks haven’t been checked yet."}`;
  if (balanceChainIds.length > 1) return `Total across ${networks}`;
  return "";
}

/** The networks ownership is verified on, as names with their marks — or the honest fallback. */
function VerifiedNetworks({ ids }: { ids: number[] }) {
  return ids.length > 0 ? (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
      <span>Verified ownership on{" "}</span>{ids.map((id, index) => <span key={id} className="inline-flex items-center gap-1">{index > 0 && " and "}<NetworkChip id={chainChipId(id)} className="px-1.5 py-0" /></span>)}
    </span>
  ) : <span className="text-xs text-muted-foreground">Network unavailable.</span>;
}

/** One bottom action row per tile: the pick action plus an independently expandable details
    disclosure — toggling it never touches the pick. Disclosed content opens below the row. */
function TileActions({ action, label, children }: { action: ReactNode; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2 px-4 pb-3">
        {action}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn("ml-auto inline-flex min-h-8 items-center text-xs text-muted-foreground", quietToggleClass)}
        >
          {label}
        </button>
      </div>
      {open && <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3 text-xs text-muted-foreground">{children}</div>}
    </>
  );
}

const tileClass = "flex min-w-0 flex-col rounded-xl bg-card ring-1 ring-foreground/10";
const tileTitleClass = "min-w-0 text-sm font-medium leading-5 [overflow-wrap:anywhere]";

/** A tile's identity: the title line with the short address on a second line whenever the
    title is a name — same-named Safes stay distinguishable; unnamed ones need no second copy. */
function TileTitle({ safe }: { safe: { name?: string; address: string } }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={tileTitleClass}>{safeTitle(safe)}</span>
      {safe.name && <span className="min-w-0 text-xs font-normal tabular-nums text-muted-foreground">{shortAddress(safe.address)}</span>}
    </span>
  );
}

/** One pickable row of "Your Safes", keyed by the Safe's lowercase address: `found` is the
    live discovery record, `saved` the earlier saved-list entry. */
type PickerRow = { key: string; address: string; name?: string; found?: FoundSafeCard; saved?: KnownSafeCard };

/** A row's tile: both faces live in one component so a saved card keeps its place and its
    disclosure state while discovery verifies it into a found one. */
function SafeTile({ row, wallet, selectedChainId, busy, discoveryComplete, freshnessByChainId, ownershipPendingByChainId, ownershipStaleByChainId, balancePendingAddresses, balanceStaleByChainId, savedFresh, staleAddresses, pendingAddresses, onPick, onResume }: {
  row: PickerRow;
  wallet?: string;
  selectedChainId?: number | null;
  busy?: boolean;
  discoveryComplete: boolean;
  freshnessByChainId?: NetworkFreshness;
  ownershipPendingByChainId?: Record<number, string[]>;
  ownershipStaleByChainId?: Record<number, string[]>;
  balancePendingAddresses?: string[];
  balanceStaleByChainId?: Record<number, string[]>;
  savedFresh: boolean;
  staleAddresses?: string[];
  pendingAddresses?: string[];
  onPick: (address: string) => void;
  onResume?: (address: string) => void;
}) {
  const s = row.found ?? row.saved?.discovery;
  const allVerified = s
    ? [...new Set([...s.chainIds, ...(row.saved?.availableChainIds ?? [])])]
    : row.saved?.availableChainIds ?? row.saved?.chainIds ?? [];
  const discoveredIds = s?.discoveredChainIds ?? s?.chainIds ?? [];
  const staleSavedIds = !savedFresh ? allVerified.filter((id) => !discoveredIds.includes(id)) : [];
  const perChainOwnershipAvailable = ownershipPendingByChainId !== undefined || ownershipStaleByChainId !== undefined;
  const legacyAddressStale = !!s && !perChainOwnershipAvailable && (staleAddresses ?? []).some((address) => same(address, s.address));
  const legacyAddressPending = !!s && !perChainOwnershipAvailable && (pendingAddresses ?? []).some((address) => same(address, s.address));
  const staleNetworkIds = allVerified.filter((id) => discoveredIds.includes(id) && (ownershipStaleByChainId
    ? ownershipStaleByChainId[id]?.some((address) => same(address, row.address))
    : freshnessByChainId?.[id] === "stale"));
  const pendingNetworkIds = allVerified.filter((id) => discoveredIds.includes(id) && ownershipPendingByChainId?.[id]?.some((address) => same(address, row.address)));
  const addressStale = legacyAddressStale;
  const addressPending = legacyAddressPending;
  const balancePerChainAvailable = balanceStaleByChainId !== undefined || balancePendingAddresses !== undefined;
  const balancePending = !!s && (balancePendingAddresses
    ? balancePendingAddresses.some((address) => same(address, s.address))
    : !balancePerChainAvailable && (pendingAddresses ?? []).some((address) => same(address, s.address)));
  const balanceStaleIds = allVerified.filter((id) => balanceStaleByChainId
    ? balanceStaleByChainId[id]?.some((address) => same(address, row.address))
    : !perChainOwnershipAvailable && (staleAddresses ?? []).some((address) => same(address, row.address)));
  const staleIds = [...new Set([...staleNetworkIds, ...staleSavedIds])];
  const verified = addressStale || addressPending ? [] : allVerified.filter((id) => !staleIds.includes(id) && !pendingNetworkIds.includes(id));
  const staleSelected = selectedChainId !== null && selectedChainId !== undefined && (staleIds.includes(selectedChainId) || pendingNetworkIds.includes(selectedChainId));
  const detailIds = staleSelected || addressStale || addressPending ? [] : verified;
  const { detailChainId, owners } = resolveDetails(s, detailIds, selectedChainId);
  const { threshold, ownerCount } = resolveApprovalSnapshot(s, detailIds, selectedChainId);
  const name = detailChainId === undefined ? undefined : chainChipId(detailChainId);
  const balanceChainIds = s ? s.balanceChainIds ?? s.chainIds : [];
  const balanceDetails = s && balanceStaleIds.length === 0 && !addressStale && !addressPending && !balancePending ? supportedBalanceDetails(s, discoveryComplete) : "";
  const setup = row.saved?.pendingSetup ? row.saved : undefined;
  const setupPending = setup?.pendingChainIds ?? setup?.chainIds ?? [];
  const setupDone = (setup?.chainIds ?? []).filter((id) => !setupPending.includes(id));
  const content: DetailContent = owners && owners.length > 0 ? "signers" : threshold !== undefined && ownerCount !== undefined ? "approvals" : "address";
  return (
    <li className={tileClass}>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <TileTitle safe={row} />
        {setup && selectedChainId !== null && selectedChainId !== undefined && !setup.availableChainIds?.includes(selectedChainId) && <span className="text-xs text-muted-foreground">Setup recovery is shown even though this Safe does not match the selected network.</span>}
        {setup && <span className="text-xs text-muted-foreground">{setupPending.length > 0
          ? <>Setup not finished{setupDone.length > 0 && <> — done on {setupDone.map(chainChipId).join(", ")}</>} — finish on {setupPending.map(chainChipId).join(", ")}. Nothing is paid again.</>
          : "Setup not finished — the Safe service has not listed it yet. Nothing is paid again."}</span>}
        {s ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-xs text-muted-foreground">{balanceStaleIds.length > 0 || balancePending || addressStale || addressPending ? "Last known supported balance" : "Supported balance"}</span>{" "}
              {s.balanceUsd === undefined ? (
                <span className="text-lg font-medium text-muted-foreground">Balance unavailable</span>
              ) : (
                <span className="text-lg font-semibold tabular-nums">{supportedBalanceAmount(s.balanceUsd)}</span>
              )}
            </div>
            {s.balanceUsd !== undefined && balanceDetails && <span className={cn("-mt-1 text-xs", balanceDetails === "No supported funds found." ? "text-warning-text" : "text-muted-foreground")}>
              {" "}{balanceDetails}
            </span>}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Saved — your wallet is checked again when you open it.</span>
        )}
        {(verified.length > 0 || (allVerified.length === 0 && !addressPending)) && <VerifiedNetworks ids={verified} />}
        {pendingNetworkIds.length > 0 && <span className="text-xs text-muted-foreground">Checking ownership on {pendingNetworkIds.map(chainChipId).join(" and ")}.</span>}
        {addressPending && <span className="text-xs text-muted-foreground">Checking this Safe again. Ownership details are from the last successful check.</span>}
        {(balancePending || addressPending) && <span className="text-xs text-muted-foreground">Checking the balance on the verified networks.</span>}
        {staleNetworkIds.length > 0 && <span className="text-xs text-warning-text">Ownership and approval details on {staleNetworkIds.map(chainChipId).join(" and ")} are from the last successful check.</span>}
        {staleSavedIds.length > 0 && <span className="text-xs text-warning-text">Saved ownership was last checked on {staleSavedIds.map(chainChipId).join(" and ")}. The saved Safe list refresh failed.</span>}
        {balanceStaleIds.length > 0 && <span className="text-xs text-warning-text">Balance values on {balanceStaleIds.map(chainChipId).join(" and ")} are from the last successful check.</span>}
        {addressStale && <span className="text-xs text-warning-text">Last known ownership details are shown because this Safe could not be rechecked.</span>}
      </div>
      <TileActions
        action={<>
          {setup && <Button size="sm" disabled={busy} onClick={() => onResume?.(row.address)}>Finish setting up</Button>}
          {(!setup || (setup.openSafeChainIds?.length ?? 0) > 0) && <Button size="sm" aria-label={openSafeLabel(row)} data-guide-target={!busy && (!setup || selectedChainId === null || selectedChainId === undefined || setup.openSafeChainIds?.includes(selectedChainId)) ? "choose-safe" : undefined} disabled={busy} onClick={() => onPick(row.address)}>Open Safe <ArrowRight data-icon="inline-end" aria-hidden /></Button>}
        </>}
        label={detailsToggleLabel(content, name, allVerified, selectedChainId)}
      >
        <span>{staleSelected ? `Approval details unavailable on ${chainChipId(selectedChainId!)}` : approvalLabel(s, detailIds, selectedChainId, allVerified.length > 1)}</span>
        {s?.assets && s.assets.length > 0 && <span>{(balanceStaleIds.length > 0 || balancePending || addressPending) && "Last known token amounts. "}{balanceChainIds.length > 0
          ? `Tokens ${balanceChainIds.length === 1 ? "on" : "across"} ${balanceChainIds.map(chainChipId).join(" and ")}`
          : "Tokens (source networks unreported)"}: {s.assets.map((a) => `${amountText(a.amount)} ${a.symbol}`).join(" · ")}</span>}
        <AddressText address={row.address} chainId={detailChainId} />
        {owners && owners.length > 0 && <Signers owners={owners} wallet={wallet} chainId={detailChainId} />}
      </TileActions>
    </li>
  );
}

/** The order "Your Safes" rows were first shown in: a card already on screen never moves
    while more of the wallet's Safes arrive or a saved card verifies into a found one. */
function useShownOrder(keys: string[]): string[] {
  const [order, setOrder] = useState(keys);
  const additions = keys.filter((key) => !order.includes(key));
  if (additions.length === 0) return order;
  const next = [...order, ...additions];
  setOrder(next);
  return next;
}

/** The Safe step of the found path (r31). */
export function SafeStep({ wallet, found, known, loading, lookupPending, discoveryIncomplete, savedLoading, savedLookupFailed, savedFresh, staleAddresses, pendingAddresses, ownershipPendingByChainId, ownershipStaleByChainId, balancePendingAddresses, balanceStaleByChainId, accountMismatch, freshnessByChainId, createDisabled, lookupFailed, existing, busy, error, onPick, onAdd, onCreate, onRetry, onResume, onUseAnotherWallet }: {
  /** The signed-in wallet: marked "You" among the signers. */
  wallet?: string;
  found: FoundSafeCard[];
  /** Safes saved earlier: still offered when the wallet lookup fails or finds nothing new. */
  known?: KnownSafeCard[];
  loading?: boolean;
  /** No owned Safe request has completed yet, including paused or offline queries. */
  lookupPending?: boolean;
  /** At least one discovery network has not completed, including paused queries after a partial response. */
  discoveryIncomplete?: boolean;
  /** The user's saved Safe list is being checked independently of wallet discovery. */
  savedLoading?: boolean;
  /** The saved Safe list failed; an empty result is not known yet. */
  savedLookupFailed?: boolean;
  /** The saved-list data currently belongs to a successful refresh. */
  savedFresh?: boolean;
  /** Previously displayed rows retained after an indeterminate ownership recheck. */
  staleAddresses?: string[];
  pendingAddresses?: string[];
  ownershipPendingByChainId?: Record<number, string[]>;
  ownershipStaleByChainId?: Record<number, string[]>;
  balancePendingAddresses?: string[];
  balanceStaleByChainId?: Record<number, string[]>;
  /** Server rejected a wallet-bound lookup because the active session belongs to another account. */
  accountMismatch?: boolean;
  freshnessByChainId?: NetworkFreshness;
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
  const none = !loading && !lookupPending && found.length === 0;
  const savedBusy = !!savedLoading;
  const savedFailed = !!savedLookupFailed;
  const empty = none && !discoveryIncomplete && !lookupFailed && !savedBusy && !savedFailed && (known?.length ?? 0) === 0;
  // Funded Safes first; the rest keep their order. This ranks a batch when it first shows —
  // once a card is on screen it keeps its place instead of re-sorting under the user.
  const sorted = [...found].sort((x, y) => Number((y.balanceUsd ?? 0) > 0) - Number((x.balanceUsd ?? 0) > 0));
  const networks = [...new Set([
    ...SERVED_CHAIN_IDS,
    ...found.flatMap((safe) => safe.chainIds),
    ...(known ?? []).flatMap((safe) => safe.pendingSetup ? safe.availableChainIds ?? [] : safe.chainIds ?? []),
  ])];
  const foundAddresses = new Set(found.map((safe) => safe.address.toLowerCase()));
  const knownByAddress = new Map((known ?? []).map((safe) => [safe.address.toLowerCase(), safe]));
  const foundRows: PickerRow[] = (accountMismatch ? [] : sorted).map((safe) => {
    const key = safe.address.toLowerCase();
    const saved = knownByAddress.get(key);
    return { key, address: safe.address, name: saved?.pendingSetup ? saved.name ?? safe.name : safe.name, found: safe, ...(saved?.pendingSetup ? { saved } : {}) };
  });
  const shownKnown = accountMismatch ? [] : (known ?? []).filter((safe) => !foundAddresses.has(safe.address.toLowerCase()));
  const savedRows: PickerRow[] = shownKnown.map((safe) => ({ key: safe.address.toLowerCase(), address: safe.address, name: safe.name, saved: safe }));
  const rowsByKey = new Map([...foundRows, ...savedRows].map((row) => [row.key, row]));
  // Lowercase address keys: a saved card that discovery later verifies keeps the same key,
  // and cards keep their first-shown order while later batches arrive.
  const rows = useShownOrder([...foundRows, ...savedRows].map((row) => row.key))
    .map((key) => rowsByKey.get(key)).filter((row): row is PickerRow => !!row);
  const visibleRows = accountMismatch ? [] : networkFilter === null ? rows
    : rows.filter((row) => row.saved?.pendingSetup || (row.found ? row.found.chainIds : row.saved?.chainIds ?? []).includes(networkFilter));
  const visibleFound = visibleRows.filter((row) => row.found);
  const hasUnknownNetwork = sorted.some((safe) => safe.chainIds.length === 0)
    || (known ?? []).some((safe) => !safe.pendingSetup && !safe.chainIds?.length && !foundAddresses.has(safe.address.toLowerCase()));
  const hasPendingSetup = visibleRows.some((row) => row.saved?.pendingSetup);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl">{hasPendingSetup ? "Finish setting up your Safe" : visibleFound.length > 0 ? "Choose a Safe" : "Your Safe"}</h1>
        {!adding && <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="text-xs font-medium text-muted-foreground">Show Safes on</legend>
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={networkFilter === null} className={cn("inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", networkFilter === null ? "border-primary bg-primary text-primary-foreground shadow-sm" : "border-border bg-background/40 text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground")} onClick={() => setNetworkFilter(null)}><NetworkChip id="All networks" className="rounded-none border-0 px-0 py-0 text-current" /></button>
            {networks.map((network) => <button key={network} type="button" aria-pressed={networkFilter === network} className={cn("inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", networkFilter === network ? "border-primary bg-primary text-primary-foreground shadow-sm" : "border-border bg-background/40 text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground")} onClick={() => setNetworkFilter(network)}><NetworkChip id={chainChipId(network)} className="rounded-none border-0 px-0 py-0 text-current" /></button>)}
          </div>
        </fieldset>}
      </div>
      <GuideIntro topicId="choose-safe" compact />
      {accountMismatch && <p role="alert" className="text-sm">Your wallet session changed while Safes were loading. Reload or sign in again to check this wallet.</p>}
      {empty && (
        <p className="max-w-2xl text-sm">
          {wallet ? <>No Safe found for <AddressText address={wallet} />. </> : "No Safe found for this wallet. "}
          Is this the wallet you use for your Safe? If not, use another wallet. You can also create a new Safe or add one you own by its address.
        </p>
      )}
      {!adding && (
        <>
        {networkFilter !== null && visibleRows.length === 0 && !loading && !lookupPending && !discoveryIncomplete && !savedBusy && !lookupFailed && !savedFailed && <p className="text-sm">{hasUnknownNetwork
          ? <>No Safes with reported network information found on {chainChipId(networkFilter)}. Choose All networks to review Safes whose network is unavailable.</>
          : <>No Safes found on {chainChipId(networkFilter)}.</>}</p>}
        {visibleRows.length > 0 && (
        <div className={gridClass}>
        <ul role="list" aria-label="Your Safes" className="contents">
          {visibleRows.map((row) => (
            <SafeTile key={row.key} row={row} wallet={wallet} selectedChainId={networkFilter} busy={busy} discoveryComplete={!loading && !discoveryIncomplete && !lookupFailed} freshnessByChainId={freshnessByChainId} ownershipPendingByChainId={ownershipPendingByChainId} ownershipStaleByChainId={ownershipStaleByChainId} balancePendingAddresses={balancePendingAddresses} balanceStaleByChainId={balanceStaleByChainId} savedFresh={savedFresh ?? true} staleAddresses={staleAddresses} pendingAddresses={pendingAddresses} onPick={onPick} onResume={onResume} />
          ))}
        </ul>
        </div>
        )}
        </>
      )}
      {!adding && (savedBusy || loading || lookupPending) && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">{savedBusy || loading ? <Spinner /> : null} {savedBusy && loading ? "Checking your saved Safes and looking for your Safes…" : savedBusy ? "Checking your saved Safes…" : loading ? "Looking for your Safes…" : lookupPending ? "Waiting for your wallet lookup to start. Check your connection. Safe creation is unavailable until a wallet result arrives." : "Looking for your Safes…"}</p>}
      {!adding && (lookupFailed || savedFailed) && (
        <div className="flex w-full max-w-md flex-col gap-2">
          <p className="text-sm">{lookupFailed && savedFailed
            ? "We could not look up your Safes or load your saved Safes. Try again."
            : lookupFailed
              ? found.length > 0
                ? "We could not finish looking up your Safes. Some Safes may be missing. Try again, or use one you saved before."
                : "We could not look up your Safes. Try again, or use one you saved before."
              : "We could not load your saved Safes. Retry to check for a setup you can continue."}</p>
          {onRetry && <Button size="lg" variant="outline" disabled={busy} onClick={onRetry}>Retry</Button>}
        </div>
      )}
      {adding ? (
        <AddSafeForm existing={existing} busy={busy} serverError={error} onSubmit={onAdd} onCancel={() => setAdding(false)} />
      ) : visibleFound.length > 0 ? (
        <details className="w-full max-w-md rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer rounded-sm text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Other options</summary>
          <div className="mt-2 flex flex-col gap-2">
            {onCreate && <Button size="lg" variant="outline" disabled={createDisabled} onClick={onCreate}>Create a new Safe</Button>}
            <Button size="lg" variant="outline" onClick={() => setAdding(true)}>Add by address</Button>
          </div>
        </details>
      ) : (
        <div className="flex w-full max-w-md flex-col gap-2">
          {empty && onUseAnotherWallet && <Button size="lg" onClick={onUseAnotherWallet}>Use another wallet</Button>}
          {onCreate && <Button size="lg" disabled={createDisabled} variant={none && !(empty && onUseAnotherWallet) ? "default" : "outline"} onClick={onCreate}>Create a new Safe</Button>}
          <Button size="lg" variant="outline" onClick={() => setAdding(true)}>Add by address</Button>
        </div>
      )}
      {!adding && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </>
  );
}
