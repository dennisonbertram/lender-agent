// Store a created Safe with its original setup data (M0-5). The row is the source of the address from now on.
import { and, eq, max } from "drizzle-orm";
import type { Hex } from "viem";
import type { Db } from "@/server/db/client";
import { safeCreations, safeNetworks, safes, userSafes } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { isSafeNetwork } from "@/lib/safe-create";
import { consentMessage, planSafe, verifyConsent } from "./plan";
import type { Address, SafeSetup } from "@/shared/types";

export type SafePreview = { name: string; address: Address; setup: SafeSetup; index: number; message: string };

/** The next unused salt index for this creator. */
export async function nextSaltIndex(db: Db, creator: Address): Promise<number> {
  const [row] = await db.select({ m: max(safeCreations.saltIndex) }).from(safeCreations).where(eq(safeCreations.creator, creator.toLowerCase()));
  return row?.m == null ? 0 : row.m + 1;
}

/** What the Review step shows and the wallet signs. Writes nothing. */
export async function previewSafe(db: Db, p: { creator: Address; name: string; cosigners: string[]; threshold: number }): Promise<SafePreview> {
  const index = await nextSaltIndex(db, p.creator);
  const { setup, address, name } = planSafe({ ...p, index });
  return { name, address, setup, index, message: consentMessage({ name, address, setup }) };
}

export type CreatedSafe = { safeId: number; address: Address; setup: SafeSetup; networks: number[] };

/**
 * Create the Safe record. The server never gets an owner key: the creator's wallet signs the setup text
 * (`consentMessage`) and we only verify it. Nothing is deployed here.
 */
export async function createSafeRecord(db: Db, p: {
  userId: number;
  creator: Address;
  name: string;
  cosigners: string[];
  threshold: number;
  index: number;
  signature: Hex;
  networks: number[];
}, deps: { client?: Parameters<typeof verifyConsent>[1] } = {}): Promise<CreatedSafe> {
  const networks = [...new Set(p.networks)];
  if (networks.length === 0 || !networks.every(isSafeNetwork)) throw new HttpError(400, "Pick at least one network.");
  const { setup, address, name } = planSafe(p);
  if (!(await verifyConsent({ name, address, setup, creator: p.creator, signature: p.signature }, deps.client))) throw new HttpError(400, "We could not check your signature. Try again.");
  // This metadata records the networks the borrower chose. It is not part of the signed setup or deployment calldata.
  const storedSetup: SafeSetup = { ...setup, createdChainIds: networks };
  const creator = p.creator.toLowerCase();
  // The same signed request again (a lost response, a double click) gets the existing record; anything else for this index is a conflict.
  const existing = async (): Promise<CreatedSafe | null> => {
    const [taken] = await db.select({ id: safes.id, address: safes.address, name: safes.name, setup: safes.setup }).from(safeCreations)
      .innerJoin(safes, eq(safes.id, safeCreations.safeId))
      .where(and(eq(safeCreations.creator, creator), eq(safeCreations.saltIndex, p.index))).limit(1);
    if (!taken) return null;
    if (taken.address !== address.toLowerCase() || taken.name !== name) throw new HttpError(409, "This Safe was already created.");
    const nets = await db.select({ chainId: safeNetworks.chainId }).from(safeNetworks).where(eq(safeNetworks.safeId, taken.id));
    return { safeId: taken.id, address, setup: taken.setup as SafeSetup, networks: nets.map((n) => n.chainId) };
  };
  const found = await existing();
  if (found) return found;
  try {
    return await insert();
  } catch (err) {
    // A concurrent identical request won the unique index: return its record.
    const again = await existing().catch(() => null);
    if (again) return again;
    throw err;
  }
  async function insert(): Promise<CreatedSafe> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(safes).values({ address: address.toLowerCase(), name, setup: storedSetup }).returning();
    await tx.insert(safeCreations).values({ safeId: row.id, creator, saltIndex: p.index, consentSignature: p.signature });
    await tx.insert(safeNetworks).values(networks.map((chainId) => ({ safeId: row.id, chainId })));
    await tx.insert(userSafes).values({ userId: p.userId, safeId: row.id });
    return { safeId: row.id, address, setup: storedSetup, networks };
  });
  }
}
