import { describe, expect, it } from "vitest";
import { SAMPLE_LOANS, TEST_PROPOSAL_INPUTS } from "../../tests/fixtures/legacy-data";
import { buildProposal } from "./proposals";
import { proposalDetail, crossedLevel, policyLogText, reserveUsedCopy, timeLabel, neutralText } from "./activity-copy";

const T = new Date(2026, 0, 5, 14, 7).getTime();

describe("timeLabel", () => {
  it("is relative for the first hour", () => {
    expect(timeLabel({ at: T }, T + 30_000)).toBe("Just now");
    expect(timeLabel({ at: T }, T + 60_000)).toBe("1 min ago");
    expect(timeLabel({ at: T }, T + 120_000)).toBe("2 min ago");
  });
  it("does not describe a future timestamp as ago", () =>
    expect(timeLabel({ at: T + 60_000 }, T)).toBe("Today 14:08"));
  it("labels older timestamps from today", () => {
    expect(timeLabel({ at: T - 61 * 60_000 }, T)).toBe("Today 13:06");
    expect(timeLabel({ at: T }, T + 61 * 60_000)).toBe("Today 14:07");
  });
  it("labels the previous calendar day", () =>
    expect(timeLabel({ at: new Date(2026, 0, 4, 17, 30).getTime() }, T)).toBe("Yesterday 17:30"));
  it("uses a dated label for older calendar days", () => {
    expect(timeLabel({ at: new Date(2026, 0, 3, 11, 20).getTime() }, T)).toBe("Jan 3, 2026 11:20");
    expect(timeLabel({ at: new Date(2025, 11, 30, 8, 10).getTime() }, T)).toBe("Dec 30, 2025 08:10");
  });
});

describe("reserveUsedCopy", () => {
  const base = { usd: 12000, venue: "Spark", supply: 5, collAsset: "ETH", repay: 4706, debtAsset: "DAI", hfBefore: 0.98, hfAfter: 1.6 };
  it("supply only", () => {
    const c = reserveUsedCopy({ ...base, repay: 0 });
    expect(c.text).toBe("Used $12,000 from Reserve Safe on your Spark loan. Done without your signature.");
    expect(c.detail).toBe("Supplied 5.00 ETH · health 0.98 → 1.60");
  });
  it("repay only", () => expect(reserveUsedCopy({ ...base, supply: 0 }).detail).toBe("Repaid 4,706 DAI · health 0.98 → 1.60"));
  it("both", () => expect(reserveUsedCopy(base).detail).toBe("Supplied 5.00 ETH, repaid 4,706 DAI · health 0.98 → 1.60"));
});

describe("crossedLevel", () => {
  it("emergency", () => expect(crossedLevel(1.2, 1.06, 1.35, 1.1)).toBe("emergency"));
  it("action", () => expect(crossedLevel(1.4, 1.2, 1.35, 1.1)).toBe("action"));
  it("already below action", () => expect(crossedLevel(1.2, 1.15, 1.35, 1.1)).toBeNull());
  it("already below emergency", () => expect(crossedLevel(1.06, 0.98, 1.35, 1.1)).toBeNull());
});

describe("policyLogText", () => {
  const p = { armed: true, emergencyHF: 1.1, dailyCapUsd: 15000, usedUsd24h: 0 };
  it("limit and trigger", () => expect(policyLogText(p, { ...p, dailyCapUsd: 20000, emergencyHF: 1.3 })).toBe("Changed reserve limit to $20,000 and trigger to health 1.30. Signed in Reserve Safe"));
  it("pause and arm", () => {
    expect(policyLogText(p, { ...p, armed: false })).toBe("Turned reserve off. Signed in Reserve Safe");
    expect(policyLogText({ ...p, armed: false }, p)).toBe("Turned reserve on. Signed in Reserve Safe");
  });
});

describe("proposalDetail", () => {
  it("drops approval steps", () =>
    expect(proposalDetail(["Allow Spark to use 13,000 DAI", "Repay 13,000 DAI on Spark"])).toBe("Repay 13,000 DAI on Spark"));
  it("joins money steps", () =>
    expect(proposalDetail(["Allow Aave v3 to use 5.00 ETH", "Supply 5.00 ETH to Aave v3", "Borrow 10,000 USDC"])).toBe("Supply 5.00 ETH to Aave v3 · Borrow 10,000 USDC"));
  it("matches a real protect proposal", () => {
    const d = proposalDetail(buildProposal("p", { kind: "protect", loanId: "spark", addColl: 0, repay: 5000 }, SAMPLE_LOANS, TEST_PROPOSAL_INPUTS).steps);
    expect(d).not.toContain("Allow");
    expect(d).toContain("Repay");
  });
});

describe("policyLogText on/off (r24)", () => {
  const p = { armed: true, emergencyHF: 1.1, dailyCapUsd: 1000, usedUsd24h: 0, usedSince: null } as never;
  it("on/off", () => {
    expect(policyLogText({ ...(p as object), armed: false } as never, p)).toContain("Turned reserve on");
    expect(policyLogText(p, { ...(p as object), armed: false } as never)).toContain("Turned reserve off");
  });
});

describe("neutralText", () => {
  it("drops a leading second person", () => {
    expect(neutralText("You removed the Lender agent from this Safe.")).toBe("Removed the Lender agent from this Safe.");
    expect(neutralText("Signed: Repay")).toBe("Signed: Repay");
    expect(neutralText("Your loan is safe")).toBe("Your loan is safe");
  });
});
