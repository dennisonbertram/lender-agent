// Set a Safe up on a network (BP-30): deploy from the stored original setup, then wait until the
// Transaction Service has indexed it. Idempotent: if the Safe is already there, nothing is sent.
import { and, eq } from "drizzle-orm";
import type { Hex } from "viem";
import { setupCostLine, type SponsorshipBudget, type SponsorshipDecision } from "@/lib/safe-create";
import type { Db } from "@/server/db/client";
import { relayerDeployments, safeCreations, safeNetworks, safes } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { SAFE_PROXY_FACTORY } from "@/server/safe/constants";
import { deploymentCalldata, predictSafeAddress } from "@/server/safe/setup";
import type { Address, SafeSetup } from "@/shared/types";
import type { Relayer } from "./relayer";
import { reserveSponsorship, sponsoredNetwork } from "./sponsorship";

export type SetupDeps = {
  db: Db;
  relayer: Relayer;
  budget: SponsorshipBudget;
  /** Is there contract code at the address on that network? */
  hasCode(chainId: number, address: Address): Promise<boolean>;
  /** Read owners and threshold from confirmed state when this Safe is already deployed. */
  getLiveSetup(chainId: number, address: Address): Promise<{ owners: Address[]; threshold: number } | null>;
  /** User payment receipt state. A missing receipt is still pending; RPC failure is treated as pending by the adapter. */
  receiptStatus(chainId: number, txHash: Hex): Promise<"pending" | "success" | "reverted">;
  /** Does the Transaction Service know this Safe on that network? */
  isIndexed(chainId: number, address: Address): Promise<boolean>;
  now?: () => Date;
};

export type SetupResult =
  /** The Safe is on the network (deployed now or before). `indexed` says whether the Transaction Service lists it yet. */
  | { status: "ready"; deployed: "by_relayer" | "already"; txHash: Hex | null; indexed: boolean }
  /** A deployment by the relayer is in flight from another call. Ask again. */
  | { status: "pending" }
  /** The user's payment is confirmed reverted; no Safe was deployed by that transaction. */
  | { status: "reverted" }
  /** Hashless wallet response recovery: live code is absent, and this path never starts deployment. */
  | { status: "not_deployed" }
  /** Not sponsored: the user pays. Their wallet sends `tx`, then they call again with its hash. */
  | { status: "user_pays"; cost: string; reason: Exclude<SponsorshipDecision, { sponsored: true }>["reason"]; tx: { to: Address; data: Hex } };

async function loadSafe(db: Db, address: string) {
  const [row] = await db.select().from(safes).where(eq(safes.address, address.toLowerCase())).limit(1);
  if (!row) throw new HttpError(404, "Safe not found");
  const setup = row.setup as SafeSetup | null;
  if (!setup) throw new HttpError(400, "This Safe was not created in the app, so it cannot be set up here.");
  return { row, setup, predicted: predictSafeAddress(setup) };
}

async function markDeployed(db: Db, safeId: number, chainId: number) {
  await db.insert(safeNetworks).values({ safeId, chainId, deployed: true }).onConflictDoUpdate({ target: [safeNetworks.safeId, safeNetworks.chainId], set: { deployed: true } });
}

/**
 * Deploy the Safe on `chainId` from its stored setup. Never recomputes the address from current owners.
 * `userTxHash` is the user's own deployment (when they pay): it is checked by reading the code.
 */
export async function setupNetwork(deps: SetupDeps, p: { address: string; chainId: number; userTxHash?: Hex }): Promise<SetupResult> {
  const { db } = deps;
  const { row, setup, predicted } = await loadSafe(db, p.address);
  if (predicted.toLowerCase() !== row.address) throw new Error("Stored setup does not match the stored address.");
  const ready = async (deployed: "by_relayer" | "already", txHash: Hex | null): Promise<SetupResult> => {
    await markDeployed(db, row.id, p.chainId);
    return { status: "ready", deployed, txHash, indexed: await deps.isIndexed(p.chainId, predicted) };
  };

  if (await deps.hasCode(p.chainId, predicted)) return ready("already", null);
  if (p.userTxHash) {
    const receipt = await deps.receiptStatus(p.chainId, p.userTxHash);
    if (receipt === "reverted") return { status: "reverted" };
    if (receipt !== "success") return { status: "pending" };
    throw new HttpError(409, "Your payment confirmed, but the Safe is not visible yet. Keep checking; do not pay again.");
  }

  // The saved setup is immutable. If an already deployed copy has changed owners or threshold, do not deploy
  // the old signer list on another network and silently reintroduce a removed owner.
  const trackedRows = await db.select({ chainId: safeNetworks.chainId }).from(safeNetworks).where(eq(safeNetworks.safeId, row.id));
  for (const { chainId } of trackedRows) {
    if (chainId === p.chainId) continue;
    const live = await deps.getLiveSetup(chainId, predicted);
    if (!live) continue;
    const sameOwners = live.owners.map((o) => o.toLowerCase()).sort().join(":") === setup.owners.map((o) => o.toLowerCase()).sort().join(":");
    if (!sameOwners || live.threshold !== setup.threshold) {
      throw new HttpError(409, "The owners or approval threshold changed on an existing network. This network was not deployed with the old setup.");
    }
  }

  const now = (deps.now ?? (() => new Date()))();
  const userPays = (reason: Exclude<SponsorshipDecision, { sponsored: true }>["reason"]): SetupResult =>
    ({ status: "user_pays", reason, cost: setupCostLine(p.chainId, { sponsored: false, reason }), tx: { to: SAFE_PROXY_FACTORY, data: deploymentCalldata(setup) } });
  // A relayer that is not configured cannot pay: say so, and let the user pay.
  if (deps.relayer.address === null) return userPays("relayer_unavailable");
  const network = sponsoredNetwork(p.chainId, deps.budget);
  if (!network.sponsored) return userPays(network.reason);

  // Estimate before sending: a deployment above the per-deployment ceiling is never sponsored.
  const [creation] = await db.select({ creator: safeCreations.creator }).from(safeCreations).where(eq(safeCreations.safeId, row.id)).limit(1);
  let estimateWei: bigint;
  try {
    estimateWei = await deps.relayer.estimate(p.chainId, setup);
  } catch {
    return userPays("relayer_unavailable");
  }
  // Budget check and claim in one transaction. A claim past its lease (a crash before or during broadcast) is taken over.
  const claim = await reserveSponsorship(db, { safeId: row.id, creator: creation?.creator ?? "", chainId: p.chainId, budget: deps.budget, estimateWei, now });
  if (!claim.reserved) {
    if (claim.reason !== "claimed") return userPays(claim.reason);
    return (await deps.hasCode(p.chainId, predicted)) ? ready("already", null) : { status: "pending" };
  }
  // Reconcile a resumed claim: if the Safe is already on chain, a previous attempt got through. Keep the row as the ledger.
  if (await deps.hasCode(p.chainId, predicted)) return ready("already", null);
  const mine = and(eq(relayerDeployments.safeId, row.id), eq(relayerDeployments.chainId, p.chainId));
  try {
    const { txHash, costWei } = await deps.relayer.deploy(p.chainId, setup);
    await db.update(relayerDeployments).set({ txHash, costWei: costWei.toString() }).where(mine);
    if (!(await deps.hasCode(p.chainId, predicted))) throw new Error("Deployed, but there is no code at the predicted address.");
    return await ready("by_relayer", txHash);
  } catch (err) {
    // Nothing was deployed: free the slot and the budget so a retry can run.
    if (!(await deps.hasCode(p.chainId, predicted).catch(() => false))) await db.delete(relayerDeployments).where(mine);
    throw err;
  }
}

/** Reconcile a lost wallet response without asking the relayer or user to deploy again. */
export async function reconcileSetupNetwork(deps: SetupDeps, p: { address: string; chainId: number }): Promise<SetupResult> {
  const { db } = deps;
  const { row, predicted } = await loadSafe(db, p.address);
  if (predicted.toLowerCase() !== row.address) throw new Error("Stored setup does not match the stored address.");
  if (!(await deps.hasCode(p.chainId, predicted))) return { status: "not_deployed" };
  await markDeployed(db, row.id, p.chainId);
  return { status: "ready", deployed: "already", txHash: null, indexed: await deps.isIndexed(p.chainId, predicted) };
}

/** Poll until the Transaction Service lists the Safe, or give up after `timeoutMs`. */
export async function waitUntilIndexed(isIndexed: () => Promise<boolean>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    if (await isIndexed()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2_000));
  }
}

/**
 * Networks a plan needs that are not ready yet, in order. For each, setup and then the agent signature
 * happen before the proposal is drafted (BP-30). `deployed` and `agentAdded` come from `safe_networks`.
 */
export async function networksNeedingSetup(db: Db, address: string, chainIds: number[]): Promise<{ chainId: number; needs: ("setup" | "agent")[] }[]> {
  const [row] = await db.select().from(safes).where(eq(safes.address, address.toLowerCase())).limit(1);
  if (!row) throw new HttpError(404, "Safe not found");
  const rows = await db.select().from(safeNetworks).where(eq(safeNetworks.safeId, row.id));
  return chainIds.flatMap((chainId) => {
    const n = rows.find((r) => r.chainId === chainId);
    const needs: ("setup" | "agent")[] = [];
    if (!n?.deployed) needs.push("setup");
    if (!n?.agentAdded) needs.push("agent");
    return needs.length ? [{ chainId, needs }] : [];
  });
}
