// The sign-in message builder. No server imports, so the browser can use it too.
import { createSiweMessage } from "viem/siwe";
import type { Address } from "@/shared/types";

export const SIGN_IN_STATEMENT = "Sign in to Lender agent. This only proves you own this wallet. No transaction is sent and no funds move.";

export function buildSignInMessage(p: { domain: string; uri: string; chainId: number; address: Address; nonce: string; now?: Date }): string {
  return createSiweMessage({
    domain: p.domain,
    uri: p.uri,
    chainId: p.chainId,
    address: p.address,
    nonce: p.nonce,
    version: "1",
    statement: SIGN_IN_STATEMENT,
    issuedAt: p.now ?? new Date(),
  });
}
