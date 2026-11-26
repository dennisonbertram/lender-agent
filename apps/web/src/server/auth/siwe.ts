// Sign-In with Ethereum (EIP-4361): build, and verify, the sign-in message. EOAs, and smart wallets (ERC-1271 / ERC-6492).
import { and, eq, gt, isNull } from "drizzle-orm";
import { verifyMessage, type PublicClient } from "viem";
import { getPublicClient } from "@/server/chain/client";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { authNonces } from "@/server/db/schema";
import type { Db } from "@/server/db/client";
import { isChainId, type Address, type Hex } from "@/shared/types";

export const NONCE_TTL_MS = 10 * 60 * 1000;
export { SIGN_IN_STATEMENT, buildSignInMessage } from "./siwe-message";

export class SiweError extends Error {}

/** Create a single-use nonce that expires in 10 minutes. */
export async function issueNonce(db: Db, now: Date = new Date()): Promise<string> {
  const nonce = generateSiweNonce();
  await db.insert(authNonces).values({ nonce, createdAt: now, expiresAt: new Date(now.getTime() + NONCE_TTL_MS) });
  return nonce;
}

/**
 * Verify a signed sign-in message. Checks the message shape, the domain, the signature, then
 * spends the nonce (it must exist, be unused and unexpired). Returns the lowercase address.
 */
export async function verifySignIn(
  db: Db,
  p: { message: string; signature: Hex; domain: string; now?: Date; publicClient?: Pick<PublicClient, "verifyMessage"> },
): Promise<{ address: Address; chainId: number }> {
  const now = p.now ?? new Date();
  const parsed = parseSiweMessage(p.message);
  const { address, nonce, chainId } = parsed;
  if (!address || !nonce || !chainId || !parsed.uri || parsed.version !== "1") throw new SiweError("Malformed sign-in message");
  if (!isChainId(chainId)) throw new SiweError("Unsupported network");
  if (!validateSiweMessage({ message: parsed as Parameters<typeof validateSiweMessage>[0]["message"], domain: p.domain, time: now })) {
    throw new SiweError("Sign-in message does not match this site");
  }
  let uriHost: string;
  try { uriHost = new URL(parsed.uri).host; } catch { throw new SiweError("Malformed sign-in message"); }
  if (uriHost !== p.domain) throw new SiweError("Sign-in message does not match this site");

  // EOA first (local ecrecover, no RPC). Otherwise ask the chain: a smart wallet such as Coinbase's
  // signs with ERC-1271, wrapped in ERC-6492 while it is not yet deployed.
  const ok =
    (await verifyMessage({ address, message: p.message, signature: p.signature }).catch(() => false)) ||
    // Contract wallets only on Base: the session is not tied to a chain, and a contract can have different controllers per chain.
    (chainId === 8453 && (await (p.publicClient ?? getPublicClient(chainId)).verifyMessage({ address, message: p.message, signature: p.signature }).catch(() => false)));
  if (!ok) throw new SiweError("Signature does not match the wallet");

  // Atomic spend: only one caller can flip usedAt from null.
  const spent = await db
    .update(authNonces)
    .set({ usedAt: now })
    .where(and(eq(authNonces.nonce, nonce), isNull(authNonces.usedAt), gt(authNonces.expiresAt, now)))
    .returning({ nonce: authNonces.nonce });
  if (spent.length === 0) throw new SiweError("Sign-in link expired or already used");
  return { address: address.toLowerCase() as Address, chainId };
}
