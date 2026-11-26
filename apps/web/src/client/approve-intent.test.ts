// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVE_INTENT_TTL_MS, markApproveIntent, proposalMatches, takeApproveIntent } from "./approve-intent";

describe("approve intent", () => {
  beforeEach(() => sessionStorage.clear());

  it("is taken once, then gone", () => {
    markApproveIntent("p1", 1000);
    expect(takeApproveIntent("p1", 1500)).toBe(true);
    expect(takeApproveIntent("p1", 1600)).toBe(false);
  });

  it("is per proposal", () => {
    markApproveIntent("p1", 1000);
    expect(takeApproveIntent("p2", 1000)).toBe(false);
    expect(takeApproveIntent("p1", 1000)).toBe(true);
  });

  it("expires", () => {
    markApproveIntent("p1", 0);
    expect(takeApproveIntent("p1", APPROVE_INTENT_TTL_MS + 1)).toBe(false);
  });

  it("is false with no mark", () => {
    expect(takeApproveIntent("p1")).toBe(false);
  });

  it("is refused when the stored record names another proposal", () => {
    markApproveIntent("p1", 1000);
    const key = sessionStorage.key(0)!;
    const rec = JSON.parse(sessionStorage.getItem(key)!);
    sessionStorage.setItem(key, JSON.stringify({ ...rec, id: "p2" }));
    expect(takeApproveIntent("p1", 1000)).toBe(false);
  });

  it("removes the record before judging it, even when it is stale", () => {
    markApproveIntent("p1", 0);
    takeApproveIntent("p1", APPROVE_INTENT_TTL_MS + 1);
    expect(sessionStorage.length).toBe(0);
  });

  it("a copy of the storage in another tab (a fresh page with no token in memory) is not honoured", async () => {
    markApproveIntent("p1", 1000);
    const copy = JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)));
    vi.resetModules();
    const other = await import("./approve-intent");
    sessionStorage.clear();
    for (const [k, v] of Object.entries(JSON.parse(copy))) sessionStorage.setItem(k, v as string);
    expect(other.takeApproveIntent("p1", 1000)).toBe(false);
  });

  describe("proposalMatches", () => {
    const view = (lock: string) => ({ chainId: 8453, facts: { changes: [{ amount: "+5,000 USDC" }, { amount: lock }] } }) as never;
    const clicked = { cash: 5000, asset: "ETH", chainId: 8453, collateral: 2.09 };
    it("matches the same cash, asset, chain and collateral", () => expect(proposalMatches(view("−2.09 ETH"), clicked)).toBe(true));
    it("refuses other collateral for the same cash", () => expect(proposalMatches(view("−3.1 ETH"), clicked)).toBe(false));
    it("allows a tiny rounding difference", () => expect(proposalMatches(view("−2.0901 ETH"), clicked)).toBe(true));
  });
});
