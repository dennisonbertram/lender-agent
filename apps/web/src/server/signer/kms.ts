// KMS/HSM signer stub (architecture section 2, rule 3). Not wired in M1.
import type { Db } from "@/server/db/client";
import type { Address, ChainId, Hex } from "@/shared/types";
import type { Signer } from "./index";

const NOT_CONFIGURED = "KMS signer not configured";

export class KmsSigner implements Signer {
  // A real KMS signer must load the stored proposal through `db` (see stored.ts) before signing.
  constructor(_db?: () => Promise<Db>) {}

  get address(): Address {
    throw new Error(NOT_CONFIGURED);
  }
  async signProposal(_p: { proposalId: string; chainId: ChainId; safe: Address }): Promise<{ safeTxHash: Hex; signature: Hex }> {
    throw new Error(NOT_CONFIGURED);
  }
  async signDeleteRequest(_p: { proposalId: string; chainId: ChainId; safe: Address; totp: number }): Promise<Hex> {
    throw new Error(NOT_CONFIGURED);
  }
}
