import type { FoundSafeCard, KnownSafeCard } from "@/components/onboarding/SafeStep";
import type { ListedSafe } from "@/server/auth/access";
import type { FoundSafe } from "@/server/safes";

const unique = <T,>(values: T[]) => [...new Set(values)];

/** Reconciles live discovery with the saved Safe list by address while preserving verified network membership and per-network details. */
export function buildSafePickerRows(discovered: FoundSafe[], saved: ListedSafe[]): { found: FoundSafeCard[]; known: KnownSafeCard[] } {
  const savedByAddress = new Map(saved.map((safe) => [safe.address.toLowerCase(), safe]));
  const found = discovered.map((safe) => {
    const savedSafe = savedByAddress.get(safe.address.toLowerCase());
    const membership = savedSafe?.verifiedChainIds ?? savedSafe?.ownedChainIds ?? [];
    return {
      ...safe,
      // Balance totals only include the networks discovery read; saved memberships do not add to the total.
      balanceChainIds: safe.balanceChainIds ?? safe.chainIds,
      chainIds: unique([...safe.chainIds, ...membership]),
    };
  });
  const foundByAddress = new Map(found.map((safe) => [safe.address.toLowerCase(), safe]));
  const known = saved
    .filter((safe) => safe.pendingSetup || !foundByAddress.has(safe.address.toLowerCase()))
    .map((safe): KnownSafeCard => {
      const address = safe.address.toLowerCase();
      const discovery = foundByAddress.get(address);
      const verified = safe.verifiedChainIds ?? safe.ownedChainIds;
      const available = unique([...verified, ...(discovery?.chainIds ?? [])]);
      return {
        address: safe.address,
        name: safe.name,
        pendingSetup: safe.pendingSetup,
        chainIds: safe.pendingSetup ? safe.createdChainIds : available,
        pendingChainIds: safe.createdChainIds.filter((id) => !safe.deployedChainIds.includes(id)),
        availableChainIds: available,
        discovery,
      };
    });
  return { found, known };
}
