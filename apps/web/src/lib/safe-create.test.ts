import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, SAFE_NETWORKS, decideSponsorship, ownersChangedWarning, setupCostLine } from "./safe-create";

const base = { chainId: 8453, budget: DEFAULT_BUDGET, perSafeUsed: 0, dailyUsed: 0 };

describe("sponsorship decision (D-03)", () => {
  it("sponsors a low-fee network inside the budget", () => {
    expect(decideSponsorship(base)).toEqual({ sponsored: true });
  });
  it("does not sponsor Ethereum", () => {
    expect(decideSponsorship({ ...base, chainId: 1 })).toEqual({ sponsored: false, reason: "network_not_sponsored" });
  });
  it("stops at the per-Safe and the daily limit", () => {
    expect(decideSponsorship({ ...base, perSafeUsed: DEFAULT_BUDGET.perSafe })).toEqual({ sponsored: false, reason: "safe_limit" });
    expect(decideSponsorship({ ...base, dailyUsed: DEFAULT_BUDGET.daily })).toEqual({ sponsored: false, reason: "daily_limit" });
  });
  it("a zero budget sponsors nothing", () => {
    expect(decideSponsorship({ ...base, budget: { ...DEFAULT_BUDGET, daily: 0 } })).toEqual({ sponsored: false, reason: "budget_off" });
    expect(decideSponsorship({ ...base, budget: { ...DEFAULT_BUDGET, perSafe: 0 } })).toEqual({ sponsored: false, reason: "budget_off" });
  });
});

describe("setup cost copy", () => {
  it("says free only when we pay", () => {
    expect(setupCostLine(8453, { sponsored: true })).toMatch(/free/i);
    for (const n of SAFE_NETWORKS) {
      for (const reason of ["network_not_sponsored", "safe_limit", "daily_limit", "budget_off"] as const) {
        const line = setupCostLine(n.chainId, { sponsored: false, reason });
        expect(line).not.toMatch(/free/i);
        expect(line).toMatch(/one-time/);
        expect(line).toMatch(/about|less than/);
      }
    }
  });
});

describe("D-06 owners changed warning", () => {
  const a = "0x1111111111111111111111111111111111111111";
  const b = "0x2222222222222222222222222222222222222222";
  it("is silent when the owners match, in any case or order", () => {
    expect(ownersChangedWarning([a, b], 2, [b.toUpperCase().replace("0X", "0x"), a], 2)).toBeNull();
  });
  it("warns when owners or threshold differ", () => {
    expect(ownersChangedWarning([a], 1, [b], 1)).toMatch(/original owners/);
    expect(ownersChangedWarning([a, b], 1, [a, b], 2)).toMatch(/original owners/);
  });
});
