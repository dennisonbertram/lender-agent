import { describe, expect, it } from "vitest";
import { safeQueueLink, safeTxLink } from "./links";

const safe = "0xe4aAb4dfF32aBd99e3DD577C230553503a6AC7B3";
const h = "0x6a5e17bbe42c3c37cb35e9ea6ab6bbf7c4fcccc0bb15ed08e1edd46c291a7573";

describe("links", () => {
  it("single-transaction link matches M0-2 (Base Sepolia)", () => {
    expect(safeTxLink(84532, safe, h)).toBe(
      `https://app.safe.global/transactions/tx?id=multisig_${safe}_${h}&safe=basesep:${safe}`,
    );
  });
  it("uses the base prefix on Base and checksums the address", () => {
    expect(safeTxLink(8453, safe.toLowerCase() as `0x${string}`, h)).toContain(`&safe=base:${safe}`);
    expect(safeQueueLink(8453, safe)).toBe(`https://app.safe.global/transactions/queue?safe=base:${safe}`);
    expect(safeQueueLink(84532, safe)).toContain("safe=basesep:");
  });
});
