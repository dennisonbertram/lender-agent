import { describe, expect, it } from "vitest";
import { MOCK_GAS_PRICE_WEI, MOCK_TX_GAS, networkFee, networkFeeUsd } from "./fee";

describe("networkFee", () => {
  it("prices the gas it is given, in ETH and cents", () => {
    expect(networkFee(250_000n, 1_000_000_000n, 3000)).toEqual({ eth: (250_000e9 / 1e18).toString(), usd: 0.75 });
  });
  it("has no dollars without an ETH price", () => expect(networkFee(1n, 1n, null).usd).toBeNull());
  it("mock mode is about two cents at ETH $3,000", () => expect(networkFeeUsd(MOCK_TX_GAS, MOCK_GAS_PRICE_WEI, 3000)).toBeCloseTo(0.02, 2));
});
