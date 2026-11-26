import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS } from "../../../tests/helpers/anvil";
import { currentTotp, delegateTypedData, deleteRequestTypedData, safeTxHash } from "./hash";
import type { SafeTx } from "@/shared/types";

const safe = "0xe4aAb4dfF32aBd99e3DD577C230553503a6AC7B3" as const;
const tx: SafeTx = {
  to: "0xdead000000000000000000000000000000000000",
  value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0",
  gasToken: "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000", nonce: "3",
};

describe("hash", () => {
  it("is deterministic and depends on chain, safe and every field", () => {
    const h = safeTxHash(8453, safe, tx);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(safeTxHash(8453, safe, tx)).toBe(h);
    expect(safeTxHash(84532, safe, tx)).not.toBe(h);
    expect(safeTxHash(8453, safe, { ...tx, nonce: "4" })).not.toBe(h);
    expect(safeTxHash(8453, safe, { ...tx, operation: 1 })).not.toBe(h);
  });

  it("totp is the hour counter", () => {
    expect(currentTotp(3_600_000 * 5 + 1234)).toBe(5);
  });

  it("delegate and delete typed data recover to the signer", async () => {
    const owner = privateKeyToAccount(ANVIL_KEYS[0]);
    const d = delegateTypedData(8453, "0x8fab000000000000000000000000000000000f33", 7);
    expect(d.domain).toEqual({ name: "Safe Transaction Service", version: "1.0", chainId: 8453 });
    const sig = await owner.signTypedData(d);
    expect(await recoverTypedDataAddress({ ...d, signature: sig })).toBe(owner.address);

    const h = safeTxHash(8453, safe, tx);
    const del = deleteRequestTypedData(8453, safe, h, 7);
    expect(del.domain.verifyingContract).toBe(safe);
    expect(del.message).toEqual({ safeTxHash: h, totp: 7n });
    const sig2 = await owner.signTypedData(del);
    expect(await recoverTypedDataAddress({ ...del, signature: sig2 })).toBe(owner.address);
  });
});
