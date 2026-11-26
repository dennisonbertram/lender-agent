import { describe, expect, it } from "vitest";
import { reservePlan } from "./loan-math";
import { blockLabel, blockMessage, capResetLabel, reserveBlock, reserveStatus, reservePreview, unmetNote } from "./reserve";

const policy = { armed: true, emergencyHF: 1.1, dailyCapUsd: 15000, usedUsd24h: 0 };
// Morpho after WBTC falls 25%: health about 1.09.
const morpho = { amount: 0.9, price: 74900 * 0.75, lt: 0.86, debt: 40000 };
const morphoBal = { coll: 0, stable: 15000 };
// Spark: 20 ETH at a dropped price, health about 1.04.
const spark = { amount: 20, price: 2400, lt: 0.82, debt: 38000 };
const sparkBal = { coll: 5, stable: 10000 };

describe("reserveBlock", () => {
  it("returns each cause, and null when a plan exists", () => {
    expect(reserveBlock(spark, 1.6, sparkBal, policy)).toBeNull();
    expect(reserveBlock(morpho, 1.6, morphoBal, policy)).toBeNull();
    expect(reserveBlock(spark, 1.6, sparkBal, { ...policy, armed: false })).toBe("paused");
    expect(reserveBlock({ ...spark, price: 5000 }, 1.6, sparkBal, policy)).toBe("notNeeded");
    expect(reserveBlock(spark, 1.6, sparkBal, { ...policy, usedUsd24h: 15000 })).toBe("capUsed");
    expect(reserveBlock(spark, 1.6, { coll: 0, stable: 0 }, policy)).toBe("noBalance");
  });
  it("lets paused win over every other cause", () => {
    expect(reserveBlock({ ...spark, price: 5000 }, 1.6, { coll: 0, stable: 0 }, { ...policy, armed: false, usedUsd24h: 15000 })).toBe("paused");
  });
  it("agrees with reservePlan(force)", () => {
    for (const p of [policy, { ...policy, usedUsd24h: 15000 }, { ...policy, armed: false }])
      expect(reserveBlock(spark, 1.6, sparkBal, p) === null).toBe(reservePlan(spark, 1.6, sparkBal, p, true) !== null);
  });
});

describe("reservePreview", () => {
  it("shows supply and repay, one asset, or the other", () => {
    const plan = reservePlan(spark, 1.6, sparkBal, policy, true)!;
    expect(reservePreview({ ...plan, supply: 5, repay: 1275, usd: 15000 }, "ETH", "DAI")).toBe("5.00 ETH + 1,275 DAI ($15,000)");
    expect(reservePreview({ ...plan, supply: 5, repay: 0, usd: 13725 }, "ETH", "DAI")).toBe("5.00 ETH ($13,725)");
    expect(reservePreview({ ...plan, supply: 0, repay: 1275, usd: 1275 }, "ETH", "DAI")).toBe("1,275 DAI ($1,275)");
  });
});

describe("capResetLabel", () => {
  const H = 3600_000;
  it("rounds up hours and handles missing or expired", () => {
    expect(capResetLabel(undefined, 1e9)).toBeNull();
    expect(capResetLabel(1e9, 1e9)).toBe("Resets in 24 h");
    expect(capResetLabel(1e9, 1e9 + 1.5 * H)).toBe("Resets in 23 h");
    expect(capResetLabel(1e9, 1e9 + 25 * H)).toBe("Resets soon");
  });
});

describe("messages", () => {
  const ctx = { cap: 15000, used: 15000, coll: "ETH", debt: "DAI", reset: "Resets in 23 h" };
  it("explain the cap and the reset time", () => {
    const m = blockMessage("capUsed", ctx);
    expect(m).toContain("$15,000 of $15,000");
    expect(m).toContain("Resets in 23 h");
    expect(m).toContain("Pick a fix below");
    expect(blockMessage("capUsed", { ...ctx, pick: "above" })).toContain("Pick another option above");
    expect(blockMessage("noBalance", ctx)).toContain("no ETH or DAI");
    expect(blockMessage("paused", ctx)).toBe("The reserve is off, so I can only suggest.");
    expect(blockMessage("notNeeded", { ...ctx, hf: 1.7 })).toContain("health 1.70");
  });
  it("label the disabled button", () => {
    const l = { hf: 1.7, target: 1.6, coll: "ETH", debt: "DAI", reset: null };
    expect(blockLabel("notNeeded", l)).toBe("Not needed: health is 1.70");
    expect(blockLabel("paused", l)).toBe("Reserve off");
    expect(blockLabel("capUsed", l)).toBe("Today's limit is used");
    expect(blockLabel("capUsed", { ...l, reset: "Resets in 23 h" })).toBe("Today's limit is used · Resets in 23 h");
    expect(blockLabel("noBalance", l)).toBe("Reserve has no ETH or DAI");
  });
  it("tell a reached limit from an empty reserve, never saying queued", () => {
    const a = unmetNote(true, 1.61), b = unmetNote(false, 1.61);
    expect(a).toBe("The daily limit is reached. I drafted the rest below (health 1.61 after you sign).");
    expect(b).toBe("The reserve ran out. I drafted the rest below (health 1.61 after you sign).");
    expect(a + b).not.toContain("queued");
  });
});

describe("reserveStatus", () => {
  const p = { armed: true, emergencyHF: 1.1, dailyCapUsd: 15000, usedUsd24h: 0 };
  it("derives one status from switch, cap and usage", () => {
    expect(reserveStatus(p, 0)).toMatchObject({ kind: "armed", label: "On", tone: "success" });
    expect(reserveStatus({ ...p, dailyCapUsd: 0 }, 0)).toMatchObject({ kind: "limitReached" });
    expect(reserveStatus({ ...p, usedUsd24h: 15000, usedSince: 0 }, 1.5 * 3600_000)).toMatchObject({ kind: "limitReached", label: "Limit reached" });
    expect(reserveStatus({ ...p, usedUsd24h: 15000, usedSince: 0 }, 1.5 * 3600_000).banner).toContain("Resets in 23 h");
    expect(reserveStatus({ ...p, armed: false, dailyCapUsd: 0 }, 0).kind).toBe("paused");
  });
  it("a $0 limit counts as used", () => {
    expect(reserveBlock(spark, 1.6, sparkBal, { ...p, dailyCapUsd: 0 })).toBe("capUsed");
  });
});

describe("reserveStatus on/off (r24)", () => {
  const base = { armed: true, emergencyHF: 1.1, dailyCapUsd: 1000, usedUsd24h: 0, usedSince: null } as never;
  it("off", () => { const s = reserveStatus({ ...(base as object), armed: false } as never, 0); expect(s.label).toBe("Off"); expect(s.banner.startsWith("Off:")).toBe(true); expect(s.kind).toBe("paused"); });
  it("on", () => { const s = reserveStatus(base, 0); expect(s.label).toBe("On"); expect(s.kind).toBe("armed"); });
});
