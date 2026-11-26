import { describe, expect, it } from "vitest";
import { allowanceNow, type RawAllowance } from "./allowance";

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const a = (o: Partial<RawAllowance> = {}): RawAllowance => ({ refill: USDC(1000), maxRefill: USDC(1000), period: 86_400n, balance: USDC(1000), timestamp: 1_000_000n, ...o });

describe("allowanceNow (lazy refill, M0-6 risk 3)", () => {
  it("full allowance: nothing waiting to reset", () => {
    expect(allowanceNow(a(), 1_000_100)).toEqual({ left: USDC(1000), limit: USDC(1000), resetsInSec: null });
  });
  it("partly used: left is the stored balance and the reset is the next period boundary", () => {
    const r = allowanceNow(a({ balance: USDC(400) }), 1_000_000 + 3600);
    expect(r.left).toBe(USDC(400));
    expect(r.resetsInSec).toBe(86_400 - 3600);
  });
  it("after the period the stored balance is still low but the read-out shows the refill", () => {
    const r = allowanceNow(a({ balance: 0n }), 1_000_000 + 86_400 + 5);
    expect(r.left).toBe(USDC(1000));
    expect(r.resetsInSec).toBeNull();
  });
  it("never above the limit, however long it was idle", () => {
    expect(allowanceNow(a({ balance: USDC(200) }), 1_000_000 + 10 * 86_400).left).toBe(USDC(1000));
  });
  it("a refill smaller than the cap adds one refill per elapsed period", () => {
    const r = allowanceNow(a({ refill: USDC(100), balance: 0n }), 1_000_000 + 3 * 86_400 + 10);
    expect(r.left).toBe(USDC(300));
    expect(r.resetsInSec).toBe(86_400 - 10);
  });
  it("period 0 never refills", () => {
    expect(allowanceNow(a({ period: 0n, balance: 5n }), 9_999_999)).toEqual({ left: 5n, limit: USDC(1000), resetsInSec: null });
  });
  it("limit used up and not yet reset reports the seconds left", () => {
    expect(allowanceNow(a({ balance: 0n }), 1_000_000 + 80_000)).toEqual({ left: 0n, limit: USDC(1000), resetsInSec: 6400 });
  });
});
