// The Safe at the same address on the destination network can be owned by someone else. A move is drafted or sent
// only when the wallet asking owns it there too: live owners when it is deployed, else the owners in the stored
// creation setup it would be deployed from. A null answer (unverifiable) is never a pass.
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { safes } from "@/server/db/schema";
import type { Address, SafeSetup } from "@/shared/types";
import type { DestinationChain } from "./arrival";
import type { MoveChain } from "./types";

/** The wallet is among the owners. */
export const ownsSafe = (owners: readonly Address[] | null, wallet: string): boolean =>
  !!owners?.some((o) => o.toLowerCase() === wallet.toLowerCase());

/** The destination Safe's live owners when the code there is a verified Safe, or null when they cannot be verified. */
export const liveDestinationOwners = (destination: DestinationChain, chainId: MoveChain, safe: Address): Promise<Address[] | null> =>
  destination.ownersOf(chainId, safe).catch(() => null);

/**
 * The owners the destination Safe will answer to for a move being planned: the live owners when it is already
 * deployed there, else the owners in the stored creation setup it would be deployed from. Null: cannot be verified.
 */
export async function plannedDestinationOwners(db: Db, destination: DestinationChain, p: { safeId: number; chainId: MoveChain; safe: Address }): Promise<Address[] | null> {
  // A failed deployment read is not "undeployed": only a confirmed false lets the stored setup's owners answer.
  const deployed = await destination.hasCode(p.chainId, p.safe).catch(() => null);
  if (deployed === null) return null;
  if (deployed) return liveDestinationOwners(destination, p.chainId, p.safe);
  const [row] = await db.select({ setup: safes.setup }).from(safes).where(eq(safes.id, p.safeId)).limit(1);
  const owners = (row?.setup as SafeSetup | null)?.owners;
  return owners?.length ? [...owners] : null;
}
