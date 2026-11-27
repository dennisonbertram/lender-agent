// Safes: find the ones a wallet owns, add one by address, and the summary every screen uses (BP-04).
import { eq } from "drizzle-orm";
import { validateAddress, shortAddress } from "@/lib/address";
import { zeroAmounts } from "@/lib/networks";
import type { Amounts, Network, Safe } from "@/lib/types";
import { recordActivity } from "@/server/activity";
import type { SafeContext } from "@/server/request";
import type { Db } from "@/server/db/client";
import { safeNetworks, safes, userSafes } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { type Services } from "@/server/services";
import { monitorStatusFor } from "@/server/monitor/status";
import { checkWorkerHealth, workerStallLimitMs } from "@/worker/health";
import { NETWORK_OF, type Address, type ChainId } from "@/shared/types";
import { DISCOVERY_CHAIN_IDS, mergeOwnedSafeSlices, type OwnedSafeSlice } from "@/lib/owned-safes";
import { listSafesForWallet } from "@/server/auth/access";
import { resolveEnsNames, type EnsResolver } from "@/server/ens";
import { loansFor, type ShellLoanView } from "@/server/loans";
import { isAddress } from "viem";

/** The networks searched for Safes: the ones the app serves (Base and Arbitrum). */
const CHAINS: ChainId[] = DISCOVERY_CHAIN_IDS;

export const NOT_OWNER_ERROR = "You are not an owner of this Safe.";

/** Bind a client cache request to the authenticated session without changing older callers that omit the header. */
export function assertExpectedWallet(req: Request, wallet: Address): void {
  const expected = req.headers.get("x-expected-wallet");
  if (expected === null) return;
  if (!isAddress(expected, { strict: false }) || expected.toLowerCase() !== wallet.toLowerCase()) throw new HttpError(409, "The signed-in wallet changed. Refresh and try again.");
}

export type FoundSafe = {
  address: Address; threshold: number; ownerCount: number; chainIds: ChainId[];
  /** Approval and signer data read directly from each verified network. */
  networkDetails?: { chainId: ChainId; threshold: number; ownerCount: number; owners: { address: Address; ens?: string }[] }[];
  /** Networks included in the returned total balance. Empty when the total could not be read everywhere. */
  balanceChainIds?: ChainId[];
  /** Total value in dollars, summed over every served network the Safe is on; absent when any of them could not be read. */
  balanceUsd?: number;
  /** The main assets held, largest first. */
  assets?: { symbol: string; amount: number }[];
  owners: { address: Address; ens?: string }[];
};

export const thresholdLabel = (k: number, n: number) => `${k} of ${n}`;

/** The r21 address errors (mockup wording), or null. */
export const validateNewSafe = (address: string, existing: string[]): string | null => validateAddress(address, existing);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Map token balances to the domain `Amounts`. Unknown symbols are ignored. */
export function amountsOf(balances: { symbol: string; amount: number }[]): Amounts {
  const out = zeroAmounts();
  for (const b of balances) if (b.symbol in out) out[b.symbol as keyof Amounts] += b.amount;
  return out;
}

/** Owners and threshold read from chain on one network, or null when the wallet is not an owner there. */
async function readOwned(services: Services, chainId: ChainId, safe: Address, wallet: Address) {
  const [owners, threshold] = await Promise.all([services.reader.readSafeOwners(chainId, safe), services.reader.readSafeThreshold(chainId, safe)]);
  if (!owners || threshold === null || !owners.some((o) => same(o, wallet))) return null;
  return { owners, threshold };
}

/** Dollar value and main assets of a Safe, or null when balances or prices cannot be read (never zero). */
async function readValue(services: Services, chainId: ChainId, safe: Address) {
  try {
    const [bal, px] = await Promise.all([services.reader.readBalances(chainId, safe), services.reader.readPrices(chainId)]);
    const rows = bal.balances.filter((b) => b.amount > 0);
    const priced = rows.map((b) => ({ symbol: b.symbol, amount: b.amount, usd: px.prices[b.symbol] === undefined ? null : b.amount * px.prices[b.symbol] }));
    if (priced.some((p) => p.usd === null)) return null;
    const balanceUsd = priced.reduce((t, p) => t + p.usd!, 0);
    const assets = priced.sort((x, y) => y.usd! - x.usd!).slice(0, 3).map(({ symbol, amount }) => ({ symbol, amount }));
    return { balanceUsd, assets };
  } catch {
    return null;
  }
}

/**
 * The wallet's owned Safes on one network: the Transaction Service's candidates, each confirmed on-chain, with
 * balance and owner names when readable. One independently completable unit of work — the progressive picker asks
 * for each network separately. On the fork only Base is searched (its Safe service throws for any other chain).
 */
export async function findOwnedSafesOnChainWithStatus(services: Services, chainId: ChainId, wallet: Address, deps: { ens?: EnsResolver } = {}): Promise<{ safes: OwnedSafeSlice[]; partial: boolean }> {
  const ens = deps.ens ?? resolveEnsNames;
  if (services.fork && chainId !== 8453) return { safes: [], partial: false };
  const addrs = await services.safeService(chainId).getSafesByOwner(wallet);
  let partial = false;
  const checked = await Promise.all([...new Set(addrs.map((a) => a.toLowerCase()))].map(async (lc) => {
    const address = addrs.find((a) => a.toLowerCase() === lc)!;
    let r: Awaited<ReturnType<typeof readOwned>>;
    try { r = await readOwned(services, chainId, address, wallet); }
    catch { partial = true; return null; }
    if (!r) return null;
    const [value, names] = await Promise.all([
      readValue(services, chainId, address),
      ens(r.owners).catch(() => new Map<string, string>()),
    ]);
    const owners = r.owners.map((o) => ({ address: o, ...(names.get(o.toLowerCase()) ? { ens: names.get(o.toLowerCase())! } : {}) }));
    return { address, chainId, threshold: r.threshold, ownerCount: r.owners.length, owners, ...(value ?? {}) };
  }));
  return { safes: checked.filter((c): c is OwnedSafeSlice => c !== null), partial };
}

/** Compatibility wrapper for callers that need only the verified rows. */
export async function findOwnedSafesOnChain(services: Services, chainId: ChainId, wallet: Address, deps: { ens?: EnsResolver } = {}): Promise<OwnedSafeSlice[]> {
  const result = await findOwnedSafesOnChainWithStatus(services, chainId, wallet, deps);
  if (result.partial) throw new Error("Owned Safe discovery was incomplete.");
  return result.safes;
}

/** Safes the wallet owns, from the Transaction Service, each confirmed on-chain, with balance and owner names when readable. */
export async function findOwnedSafes(services: Services, wallet: Address, deps: { ens?: EnsResolver } = {}): Promise<FoundSafe[]> {
  const results = await Promise.all(CHAINS.map((chainId) => findOwnedSafesOnChainWithStatus(services, chainId, wallet, deps)));
  if (results.some((result) => result.partial)) throw new Error("Owned Safe discovery was incomplete.");
  return mergeOwnedSafeSlices(results.flatMap((result) => result.safes));
}

/** Add a Safe the wallet owns to the user's list. Throws a 400 with the user-facing text; saves nothing on error. */
/** A Safe name is one line of plain text: control characters and line breaks become spaces (it is shown to every co-owner). */
export const cleanSafeName = (name: string | undefined): string => (name ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

export async function addSafe(db: Db, services: Services, p: { userId: number; wallet: Address; address: string; name?: string }) {
  const mine = await listSafesForWallet(db, services.access, p.userId);
  const bad = validateNewSafe(p.address, mine.map((s) => s.address));
  if (bad) throw new HttpError(400, bad);
  const address = p.address.trim() as Address;
  const lc = address.toLowerCase();

  const owned: { chainId: ChainId; owners: Address[]; threshold: number; agent: boolean }[] = [];
  for (const chainId of CHAINS) {
    const r = await readOwned(services, chainId, address, p.wallet);
    if (!r) continue;
    const delegates = await services.safeService(chainId).listDelegates(address);
    const agent = delegates.some((d) => same(d.delegate, services.signer.address));
    owned.push({ chainId, owners: r.owners, threshold: r.threshold, agent });
  }
  if (owned.length === 0) throw new HttpError(400, NOT_OWNER_ERROR);

  const name = cleanSafeName(p.name);
  const [existing] = await db.select().from(safes).where(eq(safes.address, lc)).limit(1);
  const [row] = existing ? [existing] : await db.insert(safes).values({ address: lc, name }).returning();
  const now = new Date();
  for (const o of owned) {
    const values = { deployed: true, agentAdded: o.agent, cachedOwners: o.owners.map((x) => x.toLowerCase()), cachedThreshold: o.threshold, ownersReadAt: now };
    await db.insert(safeNetworks).values({ safeId: row.id, chainId: o.chainId, ...values }).onConflictDoUpdate({ target: [safeNetworks.safeId, safeNetworks.chainId], set: values });
  }
  await db.insert(userSafes).values({ userId: p.userId, safeId: row.id }).onConflictDoNothing();
  await recordActivity(db, { safeId: row.id, chainId: owned[0].chainId, actor: "Agent", kind: "read", text: `Read your Safe on ${owned.map((o) => (o.chainId === 8453 ? "Base" : "Arbitrum")).join(" and ")}` });
  return { address, agent: owned.some((o) => o.agent) };
}

export type SafeSummary = {
  safe: Safe;
  chainIds: ChainId[];
  ownedChainIds: ChainId[];
  chat: boolean;
  ownersDiffer: boolean;
  threshold: number;
  ownerCount: number;
  watching: boolean;
  /** The monitor's last ticks failed or went stale: the header says so (BP-18). */
  monitorFailing: boolean;
  /** The agent is on and the worker is alive, but this Safe has not had its first check yet. */
  monitorStarting: boolean;
  /** When the monitor last checked this Safe (ISO), or null before the first check. */
  monitorLastCheckAt: string | null;
  /** The worker is alive and this Safe has no successful check yet: the first one is still due. */
  monitorFirstCheckDue: boolean;
  /** Block of the (latest) balances read. */
  balancesBlock: number;
  /** The Safe's loans in the shell's shape (BP-17). */
  loans: ShellLoanView[] | null;
  /** The loan read failed: `loans` is null, so the sidebar says so instead of "No loans". */
  loansError: boolean;
};

/** Everything the shell needs for one Safe. Balances are live, and only for networks the wallet owns (G4). */
export async function safeSummary(ctx: SafeContext): Promise<SafeSummary> {
  const { services, db, safe: row, networks, access } = ctx;
  const addr = row.address as Address;
  const owned = access.ownedChainIds;
  const reads = await Promise.all(owned.map(async (chainId) => ({
    chainId,
    bal: await services.reader.readBalances(chainId, addr),
    owners: await services.reader.readSafeOwners(chainId, addr),
    threshold: await services.reader.readSafeThreshold(chainId, addr),
  })));
  const balances: Safe["balances"] = {};
  let balancesBlock = 0;
  for (const r of reads) {
    const net: Network = NETWORK_OF[r.chainId];
    const a = amountsOf(r.bal.balances);
    const prev = balances[net];
    balances[net] = prev ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v + prev[k as keyof Amounts]])) as Amounts : a;
    balancesBlock = Math.max(balancesBlock, Number(r.bal.blockNumber));
  }
  const first = reads[0];
  const ownerCount = first?.owners?.length ?? 0;
  const threshold = first?.threshold ?? 0;
  const safe: Safe = {
    id: row.address,
    name: row.name || shortAddress(row.address),
    address: row.address,
    threshold: thresholdLabel(threshold, ownerCount),
    agent: networks.some((n) => n.agentAdded),
    networks: networks.map((n) => ({ id: NETWORK_OF[n.chainId as ChainId], deployed: n.deployed, agent: n.agentAdded })),
    balances,
  };
  const now = new Date();
  const worker = await checkWorkerHealth(db, { now, limitMs: workerStallLimitMs() });
  const monitor = await monitorStatusFor(db, row.id, owned, now);
  // "Watching" only when the worker is alive and every watched network's last check succeeded (r14).
  const watching = worker.watching && monitor.state === "watching";
  // A failed loan read must not take the whole shell down, nor pass for "no loans": it is an explicit error state.
  const loanRead = await loansFor(ctx).then((r) => r.loans.map((l) => l.shell), () => null);
  return {
    safe,
    chainIds: access.trackedChainIds,
    ownedChainIds: owned,
    chat: access.chat,
    ownersDiffer: access.ownersDiffer,
    threshold,
    ownerCount,
    watching,
    monitorFailing: monitor.state === "failing" || (monitor.state !== "not_watched" && !worker.watching),
    monitorStarting: monitor.state === "starting" && worker.watching,
    monitorFirstCheckDue: worker.watching && monitor.state !== "not_watched" && !monitor.lastCheckAt,
    monitorLastCheckAt: monitor.lastCheckAt ? monitor.lastCheckAt.toISOString() : null,
    balancesBlock,
    loans: loanRead,
    loansError: loanRead === null,
  };
}
