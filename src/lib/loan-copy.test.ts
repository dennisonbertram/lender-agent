import { describe, expect, it } from "vitest";
import { agentStatusLine, agentButtonLabel, attentionLine, safeStatusLine, limitBar, planSummary, statusSentence, alertTitle, cushionLine, loanRowLine, limitUsedPct, needsSignatures, requiredSignatures, riskBanner, severity, stageLine } from "./loan-copy";
import { liquidationPrice } from "./loan-math";
import { SAMPLE_LOANS, BASE_PRICES } from "@/data";
import { quoteLoan } from "./cash-plan";
import { demoDropNote, actionName, rateNote, scopeText } from "./loan-copy";

describe("cushionLine", () => {
  it("Spark at base prices", () => {
    expect(cushionLine("ETH", 2745, liquidationPrice(20, 0.82, 38000), 38000)).toBe("ETH can fall 16% (to $2,317) before this loan is liquidated.");
  });
  it("Spark after -25%", () => {
    const s = cushionLine("ETH", 2745 * 0.75, liquidationPrice(20, 0.82, 38000), 38000);
    expect(s).toBe("ETH is $258 below the liquidation price ($2,317).");
    expect(s).not.toMatch(/--|−-/);
  });
  it("Aave wstETH", () => {
    expect(cushionLine("wstETH", 3210, liquidationPrice(14.5, 0.81, 18000), 18000)).toBe("wstETH can fall 52% (to $1,533) before this loan is liquidated.");
  });
  it("price at liquidation", () => {
    expect(cushionLine("ETH", 2000, 2000, 1)).toBe("ETH is less than 1% above the liquidation price.");
  });
  it("zero debt", () => {
    expect(cushionLine("ETH", 2745, 0, 0)).toBe("No debt, so nothing can be liquidated.");
  });
});

it("limitUsedPct", () => {
  expect(limitUsedPct(1.185)).toBe(84);
  expect(limitUsedPct(0.89)).toBe(112);
  expect(limitUsedPct(Infinity)).toBe(0);
});

it("severity and alertTitle", () => {
  expect(severity(0.89)).toBe("now");
  expect(severity(1.0)).toBe("close");
  expect(severity(1.0218)).toBe("close");
  expect(severity(1.18)).toBe("risk");
  expect(alertTitle("Spark", 0.89)).toBe("Spark loan can be liquidated now");
  expect(alertTitle("Spark", 1.02)).toBe("Spark loan is very close to liquidation");
  expect(alertTitle("Spark", 1.18)).toBe("Spark loan is at risk");
});

it("riskBanner", () => {
  expect(riskBanner(1.18, "none")).toBe("Below your At-risk level. Add collateral or repay.");
  expect(riskBanner(1.18, "draft")).toBe("Below your At-risk level. A fix is drafted in chat. Send it to Safe, then sign.");
  expect(riskBanner(1.18, "queued")).toBe("Below your At-risk level. A fix is waiting for signatures in your Safe.");
  expect(riskBanner(0.89, "none")).toBe("This loan can be liquidated now. Add collateral or repay.");
  expect(riskBanner(1.02, "draft")).toBe("Very close to liquidation. A fix is drafted in chat. Send it to Safe, then sign.");
});

it("signatures follow the Safe threshold", () => {
  expect(requiredSignatures("2 of 3")).toBe(2);
  expect(requiredSignatures("1 of 2")).toBe(1);
  expect(requiredSignatures("bad")).toBe(2);
});

it.each([
  [0, 2, "Drafted, not yet sent to Safe."],
  [1, 1, "In your Safe queue. Needs 1 signature."],
  [1, 2, "In your Safe queue. Needs 2 signatures."],
  [2, 1, "Signed. Waiting for execution in Safe."],
  [2, 2, "1 of 2 signed. Needs 1 more signature."],
  [2, 3, "1 of 3 signed. Needs 2 more signatures."],
  [3, 2, "Done. Executed in Safe."],
] as const)("stageLine(%i, %i)", (stage, needs, text) => expect(stageLine(stage, needs)).toBe(text));

import { VENUES } from "@/data";
import { whyMorphoLine } from "./loan-copy";
it("whyMorphoLine reads VENUES", () => {
  expect(whyMorphoLine(VENUES)).toBe("Morpho Blue charges 2.9% a year, Aave v3 3.4%: $50 less per $10,000. Morpho also lets you borrow a bit more against the same ETH. The trade-off: it has much less money to lend ($38M vs $412M), so big loans and quick exits can be harder.");
});

describe("statusSentence", () => {
  it("all fine", () => expect(statusSentence(["healthy", "healthy", "healthy"])).toBe("All 3 loans are fine."));
  it("one loan fine", () => expect(statusSentence(["healthy"])).toBe("Your loan is fine."));
  it("some watch", () => expect(statusSentence(["healthy", "watch", "healthy"])).toBe("2 loans are fine. 1 to watch."));
  it("some watch, several", () => expect(statusSentence(["watch", "watch", "healthy"])).toBe("1 loan is fine. 2 to watch."));
  it("only watch", () => expect(statusSentence(["watch", "watch"])).toBe("2 loans to watch."));
  it("any risk", () => expect(statusSentence(["watch", "risk", "watch"])).toBe("1 loan needs action now. 2 to watch."));
  it("several risk", () => expect(statusSentence(["risk", "risk"])).toBe("2 loans need action now."));
  it("liquidatable", () => expect(statusSentence(["watch", "liquidatable", "watch"], "Spark")).toBe("Spark can be liquidated now. 2 to watch."));
  it("liquidatable and risk", () => expect(statusSentence(["liquidatable", "risk"], "Spark")).toBe("Spark can be liquidated now. 1 more needs action now."));
  it("no loans", () => expect(statusSentence([])).toBe(""));
});

describe("attentionLine", () => {
  it("both", () => expect(attentionLine(["risk", "watch", "watch", "healthy"])).toBe("1 needs action, 2 to watch"));
  it("watch only", () => expect(attentionLine(["watch", "healthy"])).toBe("1 to watch"));
  it("several act", () => expect(attentionLine(["risk", "liquidatable"])).toBe("2 need action"));
  it("none", () => expect(attentionLine(["healthy"])).toBe(""));
});

describe("limitBar", () => {
  it("113%", () => {
    const b = limitBar(113);
    expect(b.fill).toBe(100);
    expect(b.tick).toBeCloseTo(88.5, 1);
    expect(b.text).toBe("113% used · 13% over the limit");
  });
  it("150%", () => expect(limitBar(150).tick).toBeCloseTo(66.7, 1));
  it("100%", () => expect(limitBar(100)).toEqual({ fill: 100, tick: null, text: "100% used · liquidated at 100%" }));
  it("80%", () => expect(limitBar(80)).toEqual({ fill: 80, tick: null, text: "80% used · liquidated at 100%" }));
});

describe("agentButtonLabel", () => {
  it("0", () => expect(agentButtonLabel(0)).toBe("Lender agent"));
  it("1", () => expect(agentButtonLabel(1)).toBe("Lender agent, 1 loan needs attention"));
  it("2", () => expect(agentButtonLabel(2)).toBe("Lender agent, 2 loans need attention"));
});

it("needsSignatures pluralises", () => {
  expect(needsSignatures(1)).toBe("needs 1 signature");
  expect(needsSignatures(2)).toBe("needs 2 signatures");
});

describe("quote copy", () => {
  const t = SAMPLE_LOANS.filter((l) => l.safeId === "treasury");
  const added = quoteLoan(VENUES.find((v) => v.id === "morpho")!, "WBTC", 0.25, 10000, BASE_PRICES.WBTC, t);
  const fresh = quoteLoan(VENUES.find((v) => v.id === "aave")!, "ETH", 6, 10000, BASE_PRICES.ETH, t);
  it("actionName names the action once", () => {
    expect(actionName(added, 10000)).toEqual({ title: "Add $10,000 to your Morpho Blue loan", past: "Added $10,000 to your Morpho Blue loan." });
    expect(actionName(fresh, 10000)).toEqual({ title: "Open a $10,000 Aave v3 loan", past: "Your $10,000 Aave v3 loan is open." });
  });
  it("scopeText and rateNote only apply to additions", () => {
    expect(scopeText(added)).toBe(" on the full $50,000 loan");
    expect(scopeText(fresh)).toBe("");
    expect(rateNote(added)).toBe(" That is your loan's current rate. New Morpho Blue loans start at 2.9%.");
    expect(rateNote(fresh)).toBe("");
  });
});

describe("planSummary", () => {
  it("new loan", () => {
    expect(planSummary({ cash: 5000, venue: "Aave v3", apr: 3.1, collateral: 2.1, asset: "ETH", liqPrice: 1479.2, adding: false }))
      .toEqual(["$5,000 from Aave v3 at 3.1% · locks 2.10 ETH", "Safe unless ETH falls below $1,479"]);
  });
  it("adds to an existing loan", () => {
    expect(planSummary({ cash: 10000, venue: "Morpho Blue", apr: 3.2, collateral: 0.25, asset: "WBTC", liqPrice: 50556.4, adding: true })[0])
      .toBe("$10,000 from Morpho Blue at 3.2% · locks 0.25 WBTC more");
  });
});

describe("agentStatusLine", () => {
  it("states live counts and no fake clock", () => {
    expect(agentStatusLine(false, ["risk"])).toBe("Not watching this Safe");
    expect(agentStatusLine(true, [])).toBe("Ready. No loans to watch yet.");
    expect(agentStatusLine(true, ["healthy"])).toBe("Watching 1 loan");
    expect(agentStatusLine(true, ["watch", "watch", "risk"])).toBe("Watching 3 loans · 1 needs action");
    expect(agentStatusLine(true, ["liquidatable", "risk", "watch"])).toBe("Watching 3 loans · 2 need action");
  });
});

describe("loanRowLine", () => {
  const liq = liquidationPrice(20, 0.82, 38000);
  it("shows debt and percent cushion", () => {
    expect(loanRowLine("ETH", 2745, liq, 38000)).toBe("Borrowed $38,000 · ETH can fall 16% before liquidation");
  });
  it("handles price below liquidation", () => {
    expect(loanRowLine("ETH", 2745 * 0.75, liq, 38000)).toBe("Borrowed $38,000 · ETH is below its liquidation price");
  });
  it("handles under 1%", () => {
    expect(loanRowLine("ETH", 2000, 2000, 1)).toBe("Borrowed $1 · ETH is less than 1% above liquidation");
  });
  it("handles no debt", () => {
    expect(loanRowLine("ETH", 2745, 0, 0)).toBe("No debt");
  });
});

describe("demoDropNote", () => {
  it("names the loans the demo drop moves", () => {
    expect(demoDropNote("ETH")).toBe("Moves every ETH and wstETH loan.");
    expect(demoDropNote("wstETH")).toBe("Moves every ETH and wstETH loan.");
    expect(demoDropNote("WBTC")).toBe("Moves every WBTC loan.");
  });
});

describe("safeStatusLine", () => {
  it("covers each case", () => {
    expect(safeStatusLine([], true)).toBe("No loans yet");
    expect(safeStatusLine([], false)).toBe("Agent not added");
    expect(safeStatusLine(["healthy", "healthy"], true)).toBe("All loans healthy");
    expect(safeStatusLine(["risk", "watch", "healthy"], false)).toBe("1 needs action, 1 to watch");
    expect(safeStatusLine(["liquidatable"], true)).toBe("1 needs action");
    expect(safeStatusLine(["healthy"], false)).toBe("Agent not added");
  });
});

describe("r24 copy", () => {
  it("sends to Safe", () => {
    expect(stageLine(0, 2)).toBe("Drafted, not yet sent to Safe.");
    expect(riskBanner(1.3, "draft").endsWith("Send it to Safe, then sign.")).toBe(true);
    expect(riskBanner(1.3, "none").startsWith("Below your At-risk level.")).toBe(true);
  });
});
