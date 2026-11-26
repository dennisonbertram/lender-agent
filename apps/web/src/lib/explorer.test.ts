import { describe, expect, it } from "vitest";
import {
  explorerAddressUrl, explorerBaseUrl, explorerName, explorerTokenUrl, explorerTxUrl, formatAddress, safeAppUrl,
} from "./explorer";

const safe = "0xe4aAb4dfF32aBd99e3DD577C230553503a6AC7B3";
const h = "0x6a5e17bbe42c3c37cb35e9ea6ab6bbf7c4fcccc0bb15ed08e1edd46c291a7573";

describe("explorer", () => {
  it("maps chains to explorers", () => {
    expect(explorerBaseUrl(1)).toBe("https://etherscan.io");
    expect(explorerBaseUrl(8453)).toBe("https://basescan.org");
    expect(explorerBaseUrl(84532)).toBe("https://sepolia.basescan.org");
    expect(explorerBaseUrl(42161)).toBe("https://arbiscan.io");
    expect(explorerBaseUrl(5)).toBeNull();
    expect([1, 8453, 84532, 42161, 5].map(explorerName)).toEqual(["Etherscan", "Basescan", "Basescan", "Arbiscan", null]);
  });
  it("builds checksummed address, token and tx urls", () => {
    expect(explorerAddressUrl(8453, safe.toLowerCase())).toBe(`https://basescan.org/address/${safe}`);
    expect(explorerTokenUrl(42161, safe.toLowerCase())).toBe(`https://arbiscan.io/token/${safe}`);
    expect(explorerTxUrl(1, h)).toBe(`https://etherscan.io/tx/${h}`);
  });
  it("returns null for unknown chains or invalid input", () => {
    expect(explorerAddressUrl(5, safe)).toBeNull();
    expect(explorerAddressUrl(8453, "0x123")).toBeNull();
    expect(explorerTokenUrl(8453, "nope")).toBeNull();
    expect(explorerTxUrl(8453, "0x123")).toBeNull();
    expect(explorerTxUrl(5, h)).toBeNull();
  });
  it("builds the Safe app url", () => {
    expect(safeAppUrl(8453, safe.toLowerCase())).toBe(`https://app.safe.global/home?safe=base:${safe}`);
    expect(safeAppUrl(84532, safe)).toBe(`https://app.safe.global/home?safe=basesep:${safe}`);
    expect(safeAppUrl(1, safe)).toBe(`https://app.safe.global/home?safe=eth:${safe}`);
    expect(safeAppUrl(5, safe)).toBeNull();
    expect(safeAppUrl(8453, "bad")).toBeNull();
  });
  it("formats addresses", () => {
    expect(formatAddress(safe.toLowerCase())).toBe("0xe4aA…C7B3");
    expect(formatAddress("not an address")).toBe("not an address");
  });
});
