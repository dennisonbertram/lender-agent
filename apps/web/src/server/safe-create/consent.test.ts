import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS } from "../../../tests/helpers/anvil";
import { consentMessage, planSafe, verifyConsent } from "./plan";

describe("verifyConsent", () => {
  const creator = privateKeyToAccount(ANVIL_KEYS[1]);
  const plan = planSafe({ creator: creator.address, name: "My Safe", cosigners: [], threshold: 1, index: 0 });
  const p = { name: "My Safe", address: plan.address, setup: plan.setup, creator: creator.address };

  it("accepts the creator's own signature without asking the chain", async () => {
    const client = { verifyMessage: vi.fn(async () => true) };
    const signature = await creator.signMessage({ message: consentMessage(p) });
    expect(await verifyConsent({ ...p, signature }, client)).toBe(true);
    expect(client.verifyMessage).not.toHaveBeenCalled();
  });

  it("sends a wrong 65-byte signature to the chain (ERC-1271) and refuses when it fails there", async () => {
    const client = { verifyMessage: vi.fn(async () => false) };
    const signature = await privateKeyToAccount(ANVIL_KEYS[2]).signMessage({ message: consentMessage(p) });
    expect(await verifyConsent({ ...p, signature }, client)).toBe(false);
    expect(client.verifyMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts a 65-byte signature a deployed contract wallet validates on chain", async () => {
    const signature = await privateKeyToAccount(ANVIL_KEYS[2]).signMessage({ message: consentMessage(p) });
    expect(await verifyConsent({ ...p, signature }, { verifyMessage: vi.fn(async () => true) })).toBe(true);
  });

  it("checks a smart-wallet (longer) signature on chain", async () => {
    const signature = `0x${"ab".repeat(200)}` as const;
    expect(await verifyConsent({ ...p, signature }, { verifyMessage: vi.fn(async () => true) })).toBe(true);
    expect(await verifyConsent({ ...p, signature }, { verifyMessage: vi.fn(async () => false) })).toBe(false);
  });
});
