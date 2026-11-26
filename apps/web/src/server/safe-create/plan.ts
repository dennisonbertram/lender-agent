// Plan a new Safe: owners, threshold, pinned contracts and a stored salt nonce (M0-5, architecture 8.3).
// The address comes from the stored setup only, never from the Safe's current owners.
import { getAddress, isAddress, verifyMessage, type Hex, type PublicClient } from "viem";
import { getPublicClient } from "@/server/chain/client";
import { ownerErrors } from "@/lib/owners";
import { MAX_OWNERS } from "@/lib/safe-create";
import { HttpError } from "@/server/http";
import { deriveSaltNonce, newSafeSetup, predictSafeAddress } from "@/server/safe/setup";
import type { Address, SafeSetup } from "@/shared/types";

export type NewSafeInput = { name: string; creator: Address; cosigners: string[]; threshold: number; index: number };

/** Validate the user's input with the same rules as the form (`owners.ts`). Throws a 400 with the user-facing text. */
export function planSafe(input: NewSafeInput): { setup: SafeSetup; address: Address; name: string } {
  const name = input.name.trim();
  if (!name || name.length > 30) throw new HttpError(400, "Enter a name.");
  if (!isAddress(input.creator, { strict: false })) throw new HttpError(400, "This is not a valid address.");
  const creator = getAddress(input.creator);
  const owners = [creator, ...input.cosigners.map((c) => c.trim())];
  if (owners.length > MAX_OWNERS) throw new HttpError(400, `A Safe can have at most ${MAX_OWNERS} owners, including you.`);
  const bad = ownerErrors(owners).find((e) => e);
  if (bad) throw new HttpError(400, bad);
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > owners.length) throw new HttpError(400, "Approvals needed must be between 1 and the number of owners.");
  if (!Number.isInteger(input.index) || input.index < 0) throw new HttpError(400, "Bad request");
  const setup = newSafeSetup({ owners: owners.map((o) => getAddress(o)), threshold: input.threshold, saltNonce: deriveSaltNonce(creator, input.index) });
  return { setup, address: predictSafeAddress(setup), name };
}

/** The text the creator signs in their wallet. It names the exact address, owners and approvals; it moves no money. */
export function consentMessage(p: { name: string; address: Address; setup: SafeSetup }): string {
  return [
    `Create the Safe "${p.name}" with Lender agent.`,
    `Address: ${p.address}`,
    `Owners: ${p.setup.owners.join(", ")}`,
    `Approvals needed: ${p.setup.threshold} of ${p.setup.owners.length}`,
    `Safe ${p.setup.version}, salt ${p.setup.saltNonce}`,
    "This sets up the Safe. It does not move money.",
  ].join("\n");
}

export async function verifyConsent(
  p: { name: string; address: Address; setup: SafeSetup; creator: Address; signature: Hex },
  client?: Pick<PublicClient, "verifyMessage">,
): Promise<boolean> {
  const message = consentMessage(p);
  // EOA first (local, no RPC); a smart wallet such as Coinbase's signs with ERC-1271/6492 and needs the chain, as at sign-in.
  if (await verifyMessage({ address: p.creator, message, signature: p.signature }).catch(() => false)) return true;
  // A 65-byte signature may still be valid for a deployed contract wallet (ERC-1271), so every failure goes to the chain.
  return (client ?? getPublicClient(8453)).verifyMessage({ address: p.creator, message, signature: p.signature }).catch(() => false);
}
