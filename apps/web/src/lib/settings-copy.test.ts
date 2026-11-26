import { describe, expect, it } from "vitest";
import { levelsSavedText, standingRuleNote } from "./settings-copy";

const base = { warn: 1.6, act: 1.35 };
describe("levelsSavedText", () => {
  it("says when the status changes", () => {
    expect(levelsSavedText("Morpho Blue", 1.45, base, { warn: 1.3, act: 1.2 })).toBe("Saved. Morpho Blue now shows Healthy, not Watch (health 1.45).");
    expect(levelsSavedText("Spark", 1.18, base, { warn: 1.6, act: 1.1 })).toBe("Saved. Spark now shows Watch, not At risk (health 1.18).");
  });
  it("says when it does not", () => {
    expect(levelsSavedText("Morpho Blue", 1.45, base, { warn: 1.7, act: 1.35 })).toBe("Saved. Morpho Blue still shows Watch (health 1.45).");
  });
  it("handles no debt", () => {
    expect(levelsSavedText("Aave v3", Infinity, base, { warn: 1.7, act: 1.2 })).toBe("Saved. Aave v3 has no debt, so it stays Healthy.");
  });
});

describe("standingRuleNote", () => {
  const off = "Off. When a loan drops below its At-risk level, the agent alerts you and suggests a fix.";
  const on = "On. When a loan drops below its At-risk level, the agent drafts a repayment from this Safe's stablecoins. You still sign in Safe.";
  it("covers each state", () => {
    expect(standingRuleNote(false, true, [])).toBe(off);
    expect(standingRuleNote(true, true, [])).toBe(on);
    expect(standingRuleNote(true, true, ["Spark"])).toBe(`${on} Spark is already below it, so the rule starts with the next drop.`);
    expect(standingRuleNote(true, true, ["Spark", "Morpho Blue"])).toContain("Spark and Morpho Blue are already below it");
  });
  it("not-proposer wins", () => {
    expect(standingRuleNote(true, false, ["Spark"])).toBe("The agent is not added to this Safe, so it cannot draft anything. Add it under Lender agent.");
  });
});

describe("r24 copy", () => {
  it("names", () => {
    const n = standingRuleNote(true, false, []);
    expect(n).toContain("not added to this Safe");
    expect(n.toLowerCase()).not.toContain("proposer");
    expect(standingRuleNote(false, true, [])).toContain("At-risk level");
    expect(standingRuleNote(true, true, [])).toContain("At-risk level");
  });
});
