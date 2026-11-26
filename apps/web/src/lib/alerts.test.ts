import { describe, expect, it } from "vitest";
import { SAMPLE_LOANS, TREASURY } from "../../tests/fixtures/legacy-data";
import { alertAmounts, alertOptions, alertOnTopic, alertState, bothAmounts, optionsNote, ruleAction } from "./alerts";

const spark = SAMPLE_LOANS[2];
const ctx = { newer: false, liveHf: 1.18, warn: 1.6, openFix: false };
const alert = { hf: 1.18 };

describe("alertAmounts", () => {
  it("sizes each option to the warn level", () => {
    expect(alertAmounts(spark, 2745, 1.6)).toEqual({ addColl: 7.1, repay: 10000 });
    expect(alertAmounts(spark, 2058.75, 1.6)).toEqual({ addColl: 16.1, repay: 17000 });
    expect(bothAmounts(7.1, 10000)).toEqual({ addColl: 3.6, repay: 5000 });
  });
});

describe("alertOptions", () => {
  const m = { snap: spark, price: 2745, ...alertAmounts(spark, 2745, 1.6) };
  it("orders, recommends the cheapest, and words the rows plainly", () => {
    const o = alertOptions(m, TREASURY.balances.ethereum!);
    expect(o.map((x) => x.k)).toEqual(["repay", "coll", "both"]);
    expect(o.map((x) => x.label)).toEqual(["Repay 10,000 DAI", "Add 7.1 ETH collateral", "Add 3.6 ETH and repay 5,000 DAI"]);
    expect(o.every((x) => x.hf >= 1.6 && !x.short)).toBe(true);
    expect(o.map((x) => x.recommended)).toEqual([true, false, false]);
    expect(o.map((x) => x.sub)).toEqual(["$10,000 from your Safe", "About $19,490 from your Safe", "About $14,882 from your Safe"]);
    expect(optionsNote(o, "ETH")).toBe("Recommended uses the least money from your Safe. Afterwards ETH could fall about 38% before liquidation.");
  });
  it("puts options the Safe cannot pay for last, and recommends nothing with one usable option", () => {
    const p = 2058.75;
    const o = alertOptions({ snap: spark, price: p, ...alertAmounts(spark, p, 1.6) }, TREASURY.balances.ethereum!);
    expect(o.map((x) => [x.k, x.short])).toEqual([["repay", false], ["coll", true], ["both", true]]);
    expect(o.some((x) => x.recommended)).toBe(false);
    expect(o[1].sub).toBe("Needs 16.1 ETH. Your Safe has 8.00 ETH.");
    expect(o[0].hf).toBeGreaterThanOrEqual(1.6);
  });
  it("recommends nothing and shows no note when every option is short", () => {
    const p = 2058.75;
    const o = alertOptions({ snap: spark, price: p, ...alertAmounts(spark, p, 1.6) }, { ...TREASURY.balances.ethereum!, DAI: 0, ETH: 0 });
    expect(o.every((x) => x.short)).toBe(true);
    expect(o.some((x) => x.recommended)).toBe(false);
    expect(optionsNote(o, "ETH")).toBe("");
  });
});

describe("alertState", () => {
  it("one case per state", () => {
    expect(alertState(alert, ctx)).toBe("live");
    expect(alertState(alert, { ...ctx, liveHf: null })).toBe("closed");
    expect(alertState(alert, { ...ctx, newer: true })).toBe("replaced");
    expect(alertState(alert, { ...ctx, liveHf: 1.61 })).toBe("resolved");
    expect(alertState({ ...alert, chosen: "repay" }, { ...ctx, openFix: true })).toBe("chosen");
    expect(alertState(alert, { ...ctx, liveHf: 1.1 })).toBe("outdated");
  });
  it("resolved only at the warn level; an open fix below warn is fixing or chosen", () => {
    expect(alertState(alert, { ...ctx, liveHf: 1.45 })).not.toBe("resolved");
    expect(alertState(alert, { ...ctx, liveHf: 1.45, openFix: true })).toBe("fixing");
    expect(alertState({ ...alert, chosen: "coll" }, { ...ctx, openFix: true })).toBe("chosen");
    expect(alertState(alert, { ...ctx, liveHf: 1.61 })).toBe("resolved");
  });
  it("precedence and drift", () => {
    expect(alertState(alert, { ...ctx, newer: true, liveHf: 1.61 })).toBe("replaced");
    expect(alertState(alert, { ...ctx, newer: true, liveHf: null })).toBe("closed");
    expect(alertState({ ...alert, chosen: "repay" }, ctx)).toBe("live");
    expect(alertState({ ...alert, chosen: "repay" }, { ...ctx, openFix: true, liveHf: 1.1 })).toBe("chosen");
    expect(alertState(alert, { ...ctx, liveHf: 1.184 })).toBe("live");
    expect(alertState(alert, { ...ctx, liveHf: 1.186 })).toBe("outdated");
  });
});

describe("ruleAction", () => {
  it("drafts a repay only when the rule is on and the Safe can cover it", () => {
    expect(ruleAction(false, 5000, 9000)).toBeNull();
    expect(ruleAction(true, 5000, 5000)).toBe("draft repay");
    expect(ruleAction(true, 5000, 4999)).toBe("explain");
  });
});

describe("alertOnTopic", () => {
  it("home and own loan", () => {
    expect(alertOnTopic({ name: "home" }, "spark")).toBe(true);
    expect(alertOnTopic({ name: "loan", id: "spark" }, "spark")).toBe(true);
  });
  it("elsewhere", () => {
    for (const name of ["cash", "settings", "reserve", "activity", "offers"]) expect(alertOnTopic({ name }, "spark")).toBe(false);
    expect(alertOnTopic({ name: "loan", id: "aave" }, "spark")).toBe(false);
  });
});
