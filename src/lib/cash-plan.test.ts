import { describe, expect, it } from "vitest";
import { BASE_PRICES, SAMPLE_LOANS, VENUES, usd } from "@/data";
import { bestPlan, costLine, defaultAsset, maxCash, planFor, plansFor, quoteLoan, cashChips, cashDoneLine, feesLine, loanFeeUsd, moveQuote, lenderLimit } from "./cash-plan";
import { DEFAULT_LEVELS, MIN_LOAN, maxSafeBorrow } from "./loan-math";

const morpho = VENUES.find((v) => v.id === "morpho")!;
const P = BASE_PRICES;
const bal = { ETH: 8, wstETH: 6, WBTC: 0.5 };
const need = (cash: number, targetHf = 1.6, months = 12) => ({ cash, months, targetHf, asset: "ETH" as const, network: "ethereum" as const });

describe("planFor", () => {
  it("sizes collateral for Balanced: 10000*1.6/(2745*0.86)=6.777 -> 6.78 ETH", () => {
    const p = planFor(need(10000), 8, P.ETH, morpho);
    expect(p.collateral).toBe(6.78);
    expect(p.feasible).toBe(true);
    expect(p.hf).toBeCloseTo(1.6006, 3);
    expect(usd(p.liqPrice)).toBe("$1,715");
    expect(p.dropPct).toBe(38);
  });
  it("Lean 1.35 needs 5.718 -> 5.72 ETH (max-LTV bound 4.24 is lower)", () => {
    expect(planFor(need(10000, 1.35), 8, P.ETH, morpho).collateral).toBe(5.72);
  });
  it("applies the max-LTV bound when the target is below 1/maxLtv", () => {
    const aave = VENUES.find((v) => v.id === "aave")!;
    // target 1.0: lt bound 4.389, max-LTV bound 10000/(2745*0.805)=4.526 -> 4.53
    expect(planFor(need(10000, 1.0), 8, P.ETH, aave).collateral).toBe(4.53);
  });
  it("is infeasible when the Safe lacks the collateral", () => {
    expect(planFor(need(25000), 8, P.ETH, morpho).feasible).toBe(false);
  });
  it("is infeasible below the minimum loan or without a market", () => {
    expect(planFor(need(MIN_LOAN - 1), 8, P.ETH, morpho).feasible).toBe(false);
    expect(planFor(need(MIN_LOAN), 8, P.ETH, { ...morpho, markets: {} }).feasible).toBe(false);
  });
  it("overTime scales the yearly interest by months", () => {
    const y = (m: number) => planFor(need(10000, 1.6, m), 8, P.ETH, morpho);
    expect(y(12).yearly).toBeCloseTo(290);
    expect(y(3).overTime).toBeCloseTo(72.5);
    expect(y(12).overTime).toBeCloseTo(290);
    expect(y(24).overTime).toBeCloseTo(580);
  });
});

describe("bestPlan", () => {
  it("picks the cheapest feasible venue", () => {
    const p = bestPlan(need(10000), bal, P, VENUES)!;
    expect(p.venue.id).toBe("morpho");
  });
  it("is null when nothing is feasible", () => {
    expect(bestPlan(need(25000), bal, P, VENUES)).toBeNull();
  });
  it("skips a cheaper venue that cannot fund it", () => {
    const tight = { ...morpho, markets: {} };
    expect(bestPlan(need(10000), bal, P, [tight, ...VENUES.filter((v) => v.id !== "morpho")])!.venue.id).toBe("aave");
  });
});

describe("maxCash", () => {
  it("for 8 ETH only equals the largest maxSafeBorrow across venues (compound 12,000)", () => {
    const only = { ETH: 8, wstETH: 0, WBTC: 0 };
    const best = Math.max(...VENUES.map((v) => maxSafeBorrow(8 * P.ETH, v.markets.ETH!.lt, v.markets.ETH!.maxLtv, DEFAULT_LEVELS.warn)));
    expect(maxCash(only, P, VENUES, DEFAULT_LEVELS.warn)).toBe(best);
    expect(best).toBe(12000);
  });
  it("across the seed Safe is the WBTC/Morpho limit, 20,000", () => {
    expect(maxCash(bal, P, VENUES, 1.6)).toBe(20000);
  });
  it("is 0 for an empty Safe", () => {
    expect(maxCash({ ETH: 0, wstETH: 0, WBTC: 0 }, P, VENUES, 1.6)).toBe(0);
  });
});

describe("defaultAsset", () => {
  it("picks the largest-value asset that can fund the plan", () => {
    expect(defaultAsset(bal, P, VENUES, 10000, 1.6)).toBe("WBTC");
    expect(defaultAsset(bal, P, VENUES, 15000, 1.6)).toBe("WBTC");
  });
  it("skips an asset that cannot fund it", () => {
    expect(defaultAsset({ ETH: 1, wstETH: 6, WBTC: 0.05 }, P, VENUES, 10000, 1.6)).toBe("wstETH");
  });
  it("falls back to the largest when none can", () => {
    expect(defaultAsset({ ETH: 1, wstETH: 2, WBTC: 0 }, P, VENUES, 50000, 1.6)).toBe("wstETH");
  });
});

describe("cashChips", () => {
  it("keeps fixed amounts under the limit and ends with Up to the limit", () => {
    expect(cashChips(20000)).toEqual([{ label: "$5,000", amount: 5000 }, { label: "$10,000", amount: 10000 }, { label: "Up to $20,000", amount: 20000 }]);
  });
  it("never offers an amount above the limit", () => {
    expect(cashChips(3000)).toEqual([{ label: "Up to $3,000", amount: 3000 }]);
    expect(cashChips(30000).map((c) => c.amount)).toEqual([5000, 10000, 25000, 30000]);
  });
});

describe("costLine", () => {
  const fresh = quoteLoan(morpho, "ETH", 8, 10000, P.ETH, []);
  const added = quoteLoan(morpho, "WBTC", 0.25, 10000, P.WBTC, SAMPLE_LOANS.filter((l) => l.safeId === "treasury"));
  it("one year has no second sentence", () => {
    expect(costLine(fresh, 12)).toBe("About $290 a year at today's 2.9% rate. The rate can change.");
  });
  it("3 and 24 months add the cost over that time", () => {
    expect(costLine(fresh, 3)).toBe("About $290 a year at today's 2.9% rate. The rate can change. About $73 over 3 months.");
    expect(costLine(fresh, 24)).toBe("About $290 a year at today's 2.9% rate. The rate can change. About $580 over 2 years.");
  });
  it("an addition names the full loan and the loan's own rate", () => {
    expect(costLine(added, 12)).toBe("About $320 a year for the new $10,000 at 3.2% (about $1,600 a year on the full $50,000 loan). That is your loan's current rate. New Morpho Blue loans start at 2.9%. The rate can change.");
    expect(costLine(added, 3)).toContain(" About $80 over 3 months for the new $10,000.");
  });
});

describe("newYearly and the asset that cannot fund", () => {
  it("prices only the cash this action adds", () => {
    const q = quoteLoan(morpho, "WBTC", 0.25, 10000, P.WBTC, SAMPLE_LOANS.filter((l) => l.safeId === "treasury"));
    expect(q.newYearly).toBeCloseTo(320);
    expect(q.yearly).toBeCloseTo(1600);
    const f = quoteLoan(VENUES.find((v) => v.id === "aave")!, "WBTC", 0.25, 10000, P.WBTC, []);
    expect(f.newYearly).toBeCloseTo(340);
    expect(f.newYearly).toBeCloseTo(f.yearly);
  });
  it("ETH cannot fund $20,000 at Balanced, WBTC can", () => {
    const b = { ETH: 8, wstETH: 6, WBTC: 0.5 };
    expect(bestPlan({ cash: 20000, months: 12, targetHf: 1.6, asset: "ETH", network: "ethereum" }, b, P, VENUES)).toBeNull();
    expect(bestPlan({ cash: 20000, months: 12, targetHf: 1.6, asset: "WBTC", network: "ethereum" }, b, P, VENUES)).not.toBeNull();
  });
});

const treasury = SAMPLE_LOANS.filter((l) => l.safeId === "treasury");
const aave = VENUES.find((v) => v.id === "aave")!;

describe("quoteLoan", () => {
  it("adds to the existing Morpho loan and keeps its rate (the reference case)", () => {
    const q = quoteLoan(morpho, "WBTC", 0.25, 10000, P.WBTC, treasury);
    expect(q.scope).toBe("added");
    expect(q.apr).toBe(3.2);
    expect(q.yearly).toBeCloseTo(1600);
    expect(q.debt).toBe(50000);
    expect(q.existingDebt).toBe(40000);
    expect(q.totalCollateral).toBeCloseTo(1.15);
    expect(q.hf).toBeCloseTo(1.4815, 3);
    expect(usd(q.liqPrice)).toBe("$50,556");
    expect(q.dropPct).toBe(33);
  });
  it("a new loan uses the market rate and only the new amounts", () => {
    const q = quoteLoan(aave, "ETH", 6, 10000, P.ETH, treasury);
    expect(q.scope).toBe("new");
    expect(q.apr).toBe(3.4);
    expect(q.yearly).toBe(340);
    expect(q.debt).toBe(10000);
  });
});

describe("plans with existing loans", () => {
  it("the Morpho plan quotes the whole loan at the loan's rate", () => {
    const m = plansFor({ ...need(10000), asset: "WBTC" }, bal, P, VENUES, treasury).find((p) => p.venue.id === "morpho")!;
    expect(m.apr).toBe(3.2);
    expect(m.yearly).toBeCloseTo(m.debt * 0.032);
  });
  it("every plan's cost is its stated rate times its stated debt, sorted by quoted rate", () => {
    const ps = plansFor({ ...need(10000), asset: "WBTC" }, bal, P, VENUES, treasury);
    for (const p of ps) expect(p.yearly).toBeCloseTo((p.debt * p.apr) / 100);
    expect(ps.map((p) => p.apr)).toEqual([...ps.map((p) => p.apr)].sort((a, b) => a - b));
  });
  it("Balanced WBTC plan can fall 33% on the full loan", () => {
    expect(bestPlan({ ...need(10000), asset: "WBTC" }, bal, P, VENUES, treasury)!.dropPct).toBe(33);
  });
  it("need.collateral overrides sizing", () => {
    const p = planFor({ ...need(10000), asset: "WBTC", collateral: 0.5 }, 0.5, P.WBTC, morpho, treasury);
    expect(p.collateral).toBe(0.5);
    expect(p.dropPct).toBe(45);
    expect(usd(p.liqPrice)).toBe("$41,528");
  });
});

describe("choices that no longer fit a new amount", () => {
  it("ETH cannot back the maximum, WBTC can", () => {
    expect(bestPlan({ cash: 20000, months: 12, targetHf: 1.6, asset: "ETH", network: "ethereum" }, bal, P, VENUES)).toBeNull();
    expect(defaultAsset(bal, P, VENUES, 20000, 1.6)).toBe("WBTC");
  });
  it("Extra safe cannot back the maximum", () => {
    expect(bestPlan({ cash: 20000, months: 12, targetHf: 2.0, asset: "WBTC", network: "ethereum" }, bal, P, VENUES)).toBeNull();
  });
});

describe("cashDoneLine", () => {
  it("says where the cash is and how to move it", () => {
    expect(cashDoneLine(10000, "USDC", "Treasury Safe")).toBe("The 10,000 USDC is in Treasury Safe. To pay someone or move it to your bank, send it from the Safe app.");
  });
});

describe("feesLine", () => {
  const plan = planFor(need(7500), 8, 2745, morpho);
  it("states move and loan fees once, total = sum of rounded parts", () => {
    expect(Math.round(loanFeeUsd(2745))).toBe(11);
    expect(feesLine({ ...plan, move: moveQuote("base", "ethereum", "ETH", 4.86) }, 2745)).toBe("One-time network fees: about $15 ($4 for the move, $11 for the loan).");
  });
  it("without a move", () => expect(feesLine(plan, 2745)).toBe("One-time network fee: about $11 to set up the loan."));
});

describe("lenderLimit", () => {
  it("is the safe borrow limit, or null without a market", () => {
    expect(lenderLimit(morpho, "ETH", 5, P.ETH, 1.6)).toBe(maxSafeBorrow(5 * P.ETH, 0.86, 0.86, 1.6));
    expect(lenderLimit({ ...morpho, markets: {} }, "ETH", 5, P.ETH, 1.6)).toBeNull();
  });
});
