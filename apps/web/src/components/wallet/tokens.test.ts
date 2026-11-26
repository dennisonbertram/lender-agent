import { describe, expect, it } from "vitest";
import { tokenBySymbol } from "@/server/chain/config";
import { ARBITRUM_SEND_ASSETS, SEND_ASSETS, sendAssetsFor, sendChainsFor } from "./tokens";

describe("send assets", () => {
  it("match the server's Base token list", () => {
    for (const a of SEND_ASSETS) {
      const t = tokenBySymbol(8453, a.symbol)!;
      expect(t.address?.toLowerCase() ?? null).toBe(a.address?.toLowerCase() ?? null);
      expect(t.decimals).toBe(a.decimals);
    }
  });
  it("match the server's Arbitrum token list", () => {
    for (const a of ARBITRUM_SEND_ASSETS) {
      const t = tokenBySymbol(42161, a.symbol)!;
      expect(t.address?.toLowerCase() ?? null).toBe(a.address?.toLowerCase() ?? null);
      expect(t.decimals).toBe(a.decimals);
    }
  });
  it("offers only the owned networks that have a known asset list", () => {
    expect(sendChainsFor([42161]).map((c) => c.name)).toEqual(["Arbitrum"]);
    expect(sendChainsFor([42161, 8453]).map((c) => c.name)).toEqual(["Base", "Arbitrum"]);
    expect(sendChainsFor([1])).toEqual([]);
    expect(sendChainsFor([])).toEqual([]);
  });
  it("follows the card's own list, ignoring assets that cannot be sent", () => {
    expect(sendAssetsFor(["wstETH", "ETH", "DOGE"]).map((a) => a.symbol)).toEqual(["wstETH", "ETH"]);
    expect(sendAssetsFor(["USDC"]).map((a) => a.symbol)).toEqual(["USDC"]);
    expect(sendAssetsFor(undefined).map((a) => a.symbol)).toEqual(["ETH", "wstETH"]);
  });
});
