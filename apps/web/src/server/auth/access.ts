// Access by ownership, per (network, Safe address), read from chain at request time (G4).
import { eq, inArray } from "drizzle-orm";
import { safeNetworks, safes, userSafes, users } from "@/server/db/schema";
import type { Db } from "@/server/db/client";
import { HttpError } from "@/server/http";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import { isChainId, type Address, type ChainId } from "@/shared/types";

/**
 * The networks the app reads, monitors and lends on. A Safe can also be recorded on networks outside this set
 * (created there, setup only); those rows never reach ownership reads, monitors, delegates or the agent.
 */
export const servedOnly = (chainIds: number[]): ChainId[] => chainIds.filter((id): id is ChainId => isChainId(id) && SERVED_CHAIN_IDS.includes(id));

/** The wallet is an owner in the setup the Safe was created with (the only ownership record for a Safe with no served network). */
export const isSetupOwner = (setup: unknown, wallet: string) => !!(setup as { owners?: string[] } | null | undefined)?.owners?.some((o) => o.toLowerCase() === wallet.toLowerCase());

/** Owners of a Safe on a chain, or null when it is not deployed there. */
export type ReadOwners = (chainId: ChainId, safe: Address) => Promise<Address[] | null>;
export type ReadSetupOwners = (chainId: number, safe: Address) => Promise<Address[] | null>;

export type SafeAccess = {
  ownedChainIds: ChainId[];
  trackedChainIds: ChainId[];
  /** Chat needs ownership on every tracked network. */
  chat: boolean;
  /** The wallet owns on some tracked networks but not all. */
  ownersDiffer: boolean;
  /** Owner reads failed for these networks; they are unknown, not unowned. */
  unreadChainIds?: ChainId[];
};

export type Access = ReturnType<typeof createAccess>;

export function createAccess(opts: { readOwners: ReadOwners; readSetupOwners?: ReadSetupOwners; isIndexed?: (chainId: ChainId, safe: Address) => Promise<boolean>; cacheMs?: number; now?: () => number }) {
  const cacheMs = opts.cacheMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; owners: Promise<Address[] | null> }>();

  const owners = (chainId: ChainId, safe: Address) => {
    const key = `${chainId}:${safe.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.owners;
    const p = opts.readOwners(chainId, safe);
    cache.set(key, { at: now(), owners: p });
    // Never cache a failure.
    p.catch(() => { if (cache.get(key)?.owners === p) cache.delete(key); });
    return p;
  };

  return {
    isIndexed: opts.isIndexed,
    readSetupOwners: opts.readSetupOwners,
    async safeAccess(wallet: Address, safeAddress: Address, trackedChainIds: ChainId[]): Promise<SafeAccess> {
      const w = wallet.toLowerCase();
      trackedChainIds = servedOnly(trackedChainIds);
      const results = await Promise.allSettled(trackedChainIds.map((id) => owners(id, safeAddress)));
      const ownedChainIds = trackedChainIds.filter((_, i) => results[i]?.status === "fulfilled" && (results[i] as PromiseFulfilledResult<Address[] | null>).value?.some((o) => o.toLowerCase() === w));
      const unreadChainIds = trackedChainIds.filter((_, i) => results[i]?.status === "rejected");
      const all = trackedChainIds.length > 0 && ownedChainIds.length === trackedChainIds.length && unreadChainIds.length === 0;
      return {
        ownedChainIds,
        trackedChainIds,
        chat: all,
        ownersDiffer: ownedChainIds.length > 0 && !all && unreadChainIds.length === 0,
        unreadChainIds,
      };
    },
  };
}

/** 403 unless the wallet owns the Safe on this network. */
export function requireNetwork(access: SafeAccess, chainId: ChainId): void {
  if (!access.ownedChainIds.includes(chainId)) throw new HttpError(403, "You are not an owner of this Safe on this network");
}

/** 403 unless the wallet owns the Safe on every tracked network. */
export function requireChat(access: SafeAccess): void {
  if (!access.chat) throw new HttpError(403, "Chat needs ownership on every network of this Safe");
}

export type ListedSafe = {
  id: number; address: Address; name: string; networks: ChainId[]; ownedChainIds: ChainId[]; verifiedChainIds?: number[]; ownersDiffer: boolean;
  /** The agent is added on at least one owned network. */
  agent: boolean;
  /** The wallet owns this in-app setup and an originally selected network is undeployed or is not indexed yet. */
  pendingSetup: boolean;
  /** Networks explicitly selected when the Safe was created; these are the only networks setup resume continues. */
  createdChainIds: number[];
  /** Every network recorded for this Safe, including networks later added in Settings. */
  recordedChainIds: number[];
  /** The recorded networks where the server has already confirmed the Safe on-chain (deployed is set before the service indexes it). */
  deployedChainIds: number[];
};

/** The user's picked Safes that the wallet still owns on at least one network. */
export async function listSafesForWallet(db: Db, access: Access, userId: number, opts: { readSetupOwners?: ReadSetupOwners } = {}): Promise<ListedSafe[]> {
  const [user] = await db.select({ address: users.address }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return [];
  const wallet = user.address as Address;
  const picked = await db
    .select({ id: safes.id, address: safes.address, name: safes.name, setup: safes.setup })
    .from(userSafes)
    .innerJoin(safes, eq(safes.id, userSafes.safeId))
    .where(eq(userSafes.userId, userId));
  if (picked.length === 0) return [];
  const nets = await db.select().from(safeNetworks).where(inArray(safeNetworks.safeId, picked.map((s) => s.id)));
  const out: ListedSafe[] = [];
  for (const s of picked) {
    const rows = nets.filter((n) => n.safeId === s.id);
    const recorded = rows.map((n) => n.chainId);
    const deployed = rows.filter((n) => n.deployed).map((n) => n.chainId);
    const networks = servedOnly(recorded);
    const setupOwner = isSetupOwner(s.setup, wallet);
    const createdChainIds = (s.setup as { createdChainIds?: unknown } | null)?.createdChainIds;
    // Older records predate this metadata. Keep them usable by treating their recorded networks as the best
    // available original selection; new records never include Settings-added networks here.
    const created = Array.isArray(createdChainIds) ? createdChainIds.map(Number).filter(Number.isSafeInteger) : recorded;
    const readSetupOwners = opts.readSetupOwners ?? access.readSetupOwners;
    const checkSetupNetworks = async (ids: number[]) => {
      if (!readSetupOwners || ids.length === 0) return { owned: [] as number[], unread: [] as number[] };
      const checks = await Promise.allSettled(ids.map(async (id) => ({ id, owners: await readSetupOwners(id, s.address as Address) })));
      const owned: number[] = [];
      const unread: number[] = [];
      checks.forEach((check, i) => {
        if (check.status === "rejected") unread.push(ids[i]!);
        else if (check.value.owners?.some((o) => o.toLowerCase() === wallet.toLowerCase())) owned.push(check.value.id);
      });
      return { owned, unread };
    };
    // Set up only on networks the app does not serve: listed from the creation record, so the user can add Base or Arbitrum.
    if (networks.length === 0) {
      const deployedCreated = created.filter((id) => deployed.includes(id));
      const setupOwnerReads = await checkSetupNetworks(deployedCreated);
      const hasVerifiedOwner = setupOwnerReads.owned.length > 0;
      const pendingSetup = setupOwner && created.length > 0 && (
        (deployedCreated.length === 0) || (hasVerifiedOwner && created.some((id) => !deployed.includes(id)))
      );
      if ((pendingSetup || hasVerifiedOwner) && (setupOwner || hasVerifiedOwner)) out.push({ id: s.id, address: s.address as Address, name: s.name, networks, ownedChainIds: [], verifiedChainIds: setupOwnerReads.owned, ownersDiffer: false, agent: false, pendingSetup, createdChainIds: created, recordedChainIds: recorded, deployedChainIds: deployed });
      continue;
    }
    const a = await access.safeAccess(wallet, s.address as Address, networks);
    // The original selected networks are stored with the signed setup. Settings-added networks are not setup work.
    // A live owner can resume while an initially selected network is not deployed or its exact address is not indexed.
    // With no live ownership, only a record that has never deployed anywhere can be resumed; a missing owner/list result
    // must not turn a former owner back into an authorized setup user.
    const deployedCreated = created.filter((id) => deployed.includes(id));
    const unsupportedDeployed = deployedCreated.filter((id) => !servedOnly([id]).length);
    const setupOwnerReads = await checkSetupNetworks(unsupportedDeployed);
    const hasVerifiedSetupOwner = setupOwnerReads.owned.length > 0;
    const unindexedCreated = a.ownedChainIds.length > 0 && !!access.isIndexed
      ? (await Promise.all(servedOnly(deployedCreated).map(async (id) => await access.isIndexed!(id, s.address as Address).then((indexed) => !indexed).catch(() => false)))).some(Boolean)
      : false;
    const hasVerifiedOwner = a.ownedChainIds.length > 0 || hasVerifiedSetupOwner;
    const pendingSetup = setupOwner && created.length > 0 && (
      (hasVerifiedOwner && created.some((id) => !deployed.includes(id))) ||
      unindexedCreated ||
      (a.ownedChainIds.length === 0 && deployedCreated.length === 0)
    );
    if (a.ownedChainIds.length === 0) {
      // An off-lending Safe stays in the picker only while setup remains unfinished. After any deployment,
      // a live owner read on that deployed setup network must confirm the borrower before offering resume.
      if (pendingSetup) out.push({ id: s.id, address: s.address as Address, name: s.name, networks: [], ownedChainIds: [], verifiedChainIds: setupOwnerReads.owned, ownersDiffer: false, agent: false, pendingSetup, createdChainIds: created, recordedChainIds: recorded, deployedChainIds: deployed });
      continue;
    }
    out.push({ id: s.id, address: s.address as Address, name: s.name, networks, ownedChainIds: a.ownedChainIds, verifiedChainIds: [...new Set([...a.ownedChainIds, ...setupOwnerReads.owned])], ownersDiffer: a.ownersDiffer, agent: rows.some((n) => n.agentAdded && a.ownedChainIds.includes(n.chainId as ChainId)), pendingSetup, createdChainIds: created, recordedChainIds: recorded, deployedChainIds: deployed });
  }
  return out;
}
