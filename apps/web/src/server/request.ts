// Route-handler glue: who is asking, and what may they see. Owner: the coordinator.
// Every `/api/safes/[address]/**` handler starts with `safeContext(req, address)`.
import { eq } from "drizzle-orm";
import { isAddress } from "viem";
import { getSession, readSessionCookie, type Session } from "@/server/auth/session";
import type { SafeAccess } from "@/server/auth/access";
import { isSetupOwner, servedOnly } from "@/server/auth/access";
import { safeNetworks, safes } from "@/server/db/schema";
import type { Db } from "@/server/db/client";
import { HttpError } from "@/server/http";
import { getServices, type Services } from "@/server/services";
import type { Address, ChainId } from "@/shared/types";

/** 401 unless signed in. */
export async function requireSession(req: Request, services: Services = getServices()): Promise<{ db: Db; session: Session }> {
  const db = await services.db();
  const session = await getSession(db, readSessionCookie(req));
  if (!session) throw new HttpError(401);
  return { db, session };
}

export type SafeRow = typeof safes.$inferSelect;
export type SafeNetworkRow = typeof safeNetworks.$inferSelect;

export type SafeContext = {
  db: Db;
  services: Services;
  session: Session;
  wallet: Address;
  safe: SafeRow;
  networks: SafeNetworkRow[];
  access: SafeAccess;
};

/**
 * Load a tracked Safe and check ownership on-chain now (G4). 400 for a bad address, 404 when the
 * app does not track it, 403 when the wallet owns it on no tracked network.
 */
export async function safeContext(req: Request, address: string, services: Services = getServices()): Promise<SafeContext> {
  if (!isAddress(address, { strict: false })) throw new HttpError(400, "This is not a valid address.");
  const { db, session } = await requireSession(req, services);
  const [safe] = await db.select().from(safes).where(eq(safes.address, address.toLowerCase())).limit(1);
  if (!safe) throw new HttpError(404, "Safe not found");
  const all = await db.select().from(safeNetworks).where(eq(safeNetworks.safeId, safe.id));
  // Only served networks are read; others are recorded for the creation flow alone.
  const networks = all.filter((n) => servedOnly([n.chainId]).length > 0);
  const tracked = networks.map((n) => n.chainId as ChainId);
  const access = await services.access.safeAccess(session.address, address as Address, tracked);
  if (access.ownedChainIds.length === 0) {
    // A never-deployed Safe can be resumed by a signer from its signed setup. Once any setup network has
    // deployed, require a fresh owner read on one of those networks before exposing the Safe again.
    const setup = safe.setup as { createdChainIds?: unknown } | null;
    const createdChainIds = Array.isArray(setup?.createdChainIds) ? setup.createdChainIds.map(Number).filter(Number.isSafeInteger) : all.map((n) => n.chainId);
    const deployedSetupIds = all.filter((n) => n.deployed && createdChainIds.includes(n.chainId)).map((n) => n.chainId);
    const neverDeployed = createdChainIds.length > 0 && deployedSetupIds.length === 0;
    let ownsSetupNetwork = false;
    if (networks.length === 0 && deployedSetupIds.length > 0 && services.access.readSetupOwners) {
      const checks = await Promise.allSettled(deployedSetupIds.map((id) => services.access.readSetupOwners!(id, address as Address)));
      ownsSetupNetwork = checks.some((r) => r.status === "fulfilled" && r.value?.some((o) => o.toLowerCase() === session.address.toLowerCase()));
    }
    if (networks.length === 0 && all.length > 0 && isSetupOwner(safe.setup, session.address) && (neverDeployed || ownsSetupNetwork)) {
      return { db, services, session, wallet: session.address, safe, networks, access };
    }
    throw new HttpError(403);
  }
  return { db, services, session, wallet: session.address, safe, networks, access };
}
