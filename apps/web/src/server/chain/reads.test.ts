import { describe, expect, it } from "vitest";
import { priceAmount } from "./reads";

describe("oracle pricing", () => {
  it("keeps a position value unknown when the oracle returns zero or an invalid price", () => {
    expect(priceAmount(2, 0)).toBeNull();
    expect(priceAmount(2, Number.NaN)).toBeNull();
    expect(priceAmount(2, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("values a positive amount with a positive oracle price", () => {
    expect(priceAmount(2, 3000)).toBe(6000);
  });
});
