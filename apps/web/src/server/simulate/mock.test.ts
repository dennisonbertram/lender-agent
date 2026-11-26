import { describe, expect, it } from "vitest";
import { createMockServices } from "@/server/services";
import { testRun } from "@/server/proposals/test-run";
import { MOCK_SAFE } from "@/server/mock/seed";

const open = (amount: number, borrow: number) => ({ kind: "open" as const, venueId: "aave-v3", asset: "ETH" as const, amount, borrow, safeId: MOCK_SAFE, network: "base" as const });

describe("mock Test run (MOCK=1)", () => {
  it("passes an open within the Safe's balance, with the lender's health formula", async () => {
    const s = createMockServices({ db: async () => { throw new Error("no db"); } });
    const r = await testRun({ chainId: 8453, safe: MOCK_SAFE, spec: open(1, 1000), healthBefore: null, atRiskLevel: 1.35 }, s.testRunDeps);
    expect(r.ok).toBe(true);
    expect(r.healthAfter).toBeCloseTo((3000 * 0.83) / 1000, 6);
    expect(r.line).toBe("Checked: this would work. Network fee about $0.02.");
    expect(r.steps).toContain("Wrap ETH");
  });

  it("fails at the step that cannot run", async () => {
    const s = createMockServices({ db: async () => { throw new Error("no db"); } });
    const tooMuchEth = await testRun({ chainId: 8453, safe: MOCK_SAFE, spec: open(10, 1000), healthBefore: null, atRiskLevel: 1.35 }, s.testRunDeps);
    expect(tooMuchEth).toMatchObject({ ok: false, canSend: false, failedStep: 0 });
    const tooMuchDebt = await testRun({ chainId: 8453, safe: MOCK_SAFE, spec: open(1, 2900), healthBefore: null, atRiskLevel: 1.35 }, s.testRunDeps);
    expect(tooMuchDebt.ok).toBe(false);
    expect(tooMuchDebt.reason).toContain("Borrow");
  });
});
