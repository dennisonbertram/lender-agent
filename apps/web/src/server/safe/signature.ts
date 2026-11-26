// Safe signature helpers shared by the fake service, the owner routes and the executor:
// recovery for v 27/28 (EIP-712) and 31/32 (eth_sign), sorted packing, and the v=1 pre-validated entry.
import { concatHex, hashMessage, hexToNumber, pad, recoverAddress, slice, type Hex } from "viem";
import type { Address } from "@/shared/types";

/**
 * Recover the signer of a Safe-style signature over a 32-byte hash. v 27/28 is a raw EIP-712
 * signature (what delegates and owners send); v 31/32 is eth_sign style (hash prefixed with the
 * personal-message header, v minus 4). v 0/1 as a raw ECDSA parity is accepted here only for the
 * Transaction Service stand-in; the app's owner route rejects it (`isOwnerEcdsaSignature`).
 */
export async function recoverSafeSignature(hash: Hex, signature: Hex): Promise<Address | null> {
  if (signature.length !== 132) return null;
  const v = hexToNumber(slice(signature, 64, 65));
  try {
    if (v === 27 || v === 28 || v === 0 || v === 1) return await recoverAddress({ hash, signature });
    if (v === 31 || v === 32) {
      const adjusted = (slice(signature, 0, 64) + (v - 4).toString(16)) as Hex;
      return await recoverAddress({ hash: hashMessage({ raw: hash }), signature: adjusted });
    }
  } catch {
    return null;
  }
  return null;
}

/** A 65-byte `r‖s‖v` with v 27 or 28: the only shape the app accepts from a wallet's signTypedData. */
export function isOwnerEcdsaSignature(signature: string): signature is Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const v = hexToNumber(slice(signature as Hex, 64, 65));
  return v === 27 || v === 28;
}

/** The pre-validated signature (`checkNSignatures`, v=1): r = owner (left padded), s = 0. Valid for msg.sender == owner or an approved hash. */
export function preValidatedSignature(owner: Address): Hex {
  return concatHex([pad(owner, { size: 32 }), `0x${"00".repeat(32)}`, "0x01"]);
}

/** True when `signature` is the v=1 entry for `owner`. */
export function isPreValidatedFor(signature: Hex, owner: Address): boolean {
  return signature.length === 132 && signature.toLowerCase() === preValidatedSignature(owner).toLowerCase();
}

/** Concatenate signatures sorted by owner address ascending (numeric), as `checkNSignatures` requires. */
export function packSignatures(entries: { owner: Address; signature: Hex }[]): Hex {
  const sorted = [...entries].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : BigInt(a.owner) > BigInt(b.owner) ? 1 : 0));
  return concatHex(sorted.map((e) => e.signature));
}
