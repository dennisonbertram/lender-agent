// The proposer signer (architecture section 2, rule 3). Exactly two operations, and no
// sign-arbitrary-bytes path: both take a stored proposal id and sign only what is stored (see stored.ts).
import type { Db } from "@/server/db/client";
import type { Address, ChainId, Hex } from "@/shared/types";
import { getDb } from "@/server/db/client";
import { DevSigner } from "./dev";
import { KeySigner } from "./key";
import { KmsSigner } from "./kms";

export interface Signer {
  address: Address;
  /** Load the stored proposal, recompute its Safe transaction hash and sign it (EIP-712, as the service expects). */
  signProposal(p: { proposalId: string; chainId: ChainId; safe: Address }): Promise<{ safeTxHash: Hex; signature: Hex }>;
  /** Sign the Transaction Service `DeleteRequest` for a stored proposal this agent made. Refused when owners confirmed it. */
  signDeleteRequest(p: { proposalId: string; chainId: ChainId; safe: Address; totp: number }): Promise<Hex>;
}

export function getSigner(env: Record<string, string | undefined> = process.env, db: () => Promise<Db> = getDb): Signer {
  const kind = env.PROPOSER_SIGNER ?? "dev";
  if (kind === "dev") return new DevSigner(env.DEV_PROPOSER_KEY as Hex | undefined, db);
  if (kind === "key") return new KeySigner(env.PROPOSER_PRIVATE_KEY, db);
  if (kind === "kms") return new KmsSigner(db);
  throw new Error(`Unknown PROPOSER_SIGNER "${kind}" (expected dev, key or kms)`);
}

export { DevSigner, KeySigner, KmsSigner };
