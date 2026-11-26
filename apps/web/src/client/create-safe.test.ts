import { describe, expect, it, vi } from "vitest";
import { assertWalletOwner, classifySetupPaymentReplacement, ensureWalletChain } from "./create-safe";

describe("ensureWalletChain (review 4)", () => {
  it("does nothing on the right network", async () => {
    const sw = vi.fn();
    await ensureWalletChain(8453, 8453, sw);
    expect(sw).not.toHaveBeenCalled();
  });
  it("switches a wallet on another network to the preview's chain", async () => {
    const sw = vi.fn(async () => {});
    await ensureWalletChain(1, 8453, sw);
    expect(sw).toHaveBeenCalledWith(8453);
  });
  it("rejects when the wallet will not switch, before anything is sent", async () => {
    await expect(ensureWalletChain(1, 8453, async () => { throw new Error("no"); })).rejects.toThrow(/Switch your wallet to Base/);
  });
});

describe("assertWalletOwner", () => {
  it("permits the session owner case-insensitively", () => {
    expect(() => assertWalletOwner("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8")).not.toThrow();
  });
  it("refuses to send when the connected wallet changed from the session owner", () => {
    expect(() => assertWalletOwner("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toThrow(/connected wallet changed/i);
  });
});

describe("setup payment transaction replacement", () => {
  const intended = { to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0x1688f0b9", value: 0n } as const;
  it("keeps a confirmed same-call speed-up under its replacement hash", () => {
    expect(classifySetupPaymentReplacement({
      reason: "repriced", transaction: { hash: "0xnew", to: intended.to, input: intended.data, value: 0n },
    }, intended)).toEqual({ outcome: "setup", hash: "0xnew" });
  });
  it("recognizes a same-call replacement but resolves a mined cancellation", () => {
    expect(classifySetupPaymentReplacement({
      reason: "replaced", transaction: { hash: "0xnew", to: intended.to, input: intended.data, value: 0n },
    }, intended)).toEqual({ outcome: "setup", hash: "0xnew" });
    expect(classifySetupPaymentReplacement({
      reason: "cancelled", transaction: { hash: "0xcancel", to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", input: "0x", value: 0n },
    }, intended)).toEqual({ outcome: "cancelled", hash: "0xcancel" });
  });
  it("does not treat a different successful replacement as the setup payment", () => {
    expect(classifySetupPaymentReplacement({
      reason: "replaced", transaction: { hash: "0xother", to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", input: "0x", value: 0n },
    }, intended)).toEqual({ outcome: "replaced", hash: "0xother" });
  });
});
