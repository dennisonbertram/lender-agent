// Production signer: the proposer key from PROPOSER_PRIVATE_KEY. Same contract as DevSigner (stored proposals only).
// Anvil's public keys are refused, and no error message ever contains the key.
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "@/server/db/client";
import type { Address, ChainId, Hex } from "@/shared/types";
import { ANVIL_DEV_KEYS } from "./dev";
import type { Signer } from "./index";
import { signStoredDeleteRequest, signStoredProposal } from "./stored";

export class KeySigner implements Signer {
  private readonly account;
  readonly address: Address;

  constructor(key: string | undefined, private readonly db: () => Promise<Db>) {
    if (!key) throw new Error("PROPOSER_PRIVATE_KEY is not set");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("PROPOSER_PRIVATE_KEY is malformed (expected 0x followed by 64 hex characters)");
    if (ANVIL_DEV_KEYS.includes(key.toLowerCase() as Hex)) throw new Error("PROPOSER_PRIVATE_KEY is a public anvil key; refusing to use it");
    try {
      this.account = privateKeyToAccount(key as Hex);
    } catch {
      throw new Error("PROPOSER_PRIVATE_KEY is not a valid secp256k1 private key"); // viem's error would print the value
    }
    this.address = this.account.address;
  }

  async signProposal(p: { proposalId: string; chainId: ChainId; safe: Address }) {
    return signStoredProposal(this.account, await this.db(), p);
  }

  async signDeleteRequest(p: { proposalId: string; chainId: ChainId; safe: Address; totp: number }) {
    return signStoredDeleteRequest(this.account, await this.db(), p);
  }
}
