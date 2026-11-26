import { expect, it } from "vitest";
import { BALANCES, SAMPLE_LOANS, PRICES, VENUES } from "@/data";
import { DEFAULT_LEVELS } from "./loan-math";
import { LOAN_STEPS, loanFeeUsd, moveQuote, quoteLoan } from "./cash-plan";
import { advanceAction, balancesAfter, buildProposal, nextStage, stoppedLine, testRunLine } from "./proposals";

it("open moves collateral out and the borrowed stablecoin in, without mutating the input", () => {
  const before = { ...BALANCES };
  const a = balancesAfter(BALANCES, { kind: "open", venueId: "morpho", asset: "ETH", amount: 8, borrow: 10000, safeId: "treasury", network: "ethereum" }, SAMPLE_LOANS);
  expect(a.ETH).toBe(0);
  expect(a.USDC).toBe(55000);
  expect(BALANCES).toEqual(before);
});
it("close returns collateral and pays debt plus accrued interest", () => {
  const a = balancesAfter(BALANCES, { kind: "close", loanId: "spark" }, SAMPLE_LOANS);
  expect(a.ETH).toBe(28);
  expect(a.DAI).toBeCloseTo(40000 - 38388.1);
});
it("protect spends collateral and repayment; refi changes nothing", () => {
  const a = balancesAfter(BALANCES, { kind: "protect", loanId: "spark", addColl: 2, repay: 5000 }, SAMPLE_LOANS);
  expect(a.ETH).toBe(6);
  expect(a.DAI).toBe(35000);
  expect(balancesAfter(BALANCES, { kind: "refi", loanId: "spark", venueId: "aave" }, SAMPLE_LOANS)).toEqual(BALANCES);
});
it("clamps at 0", () => {
  expect(balancesAfter(BALANCES, { kind: "protect", loanId: "spark", addColl: 0, repay: 99999 }, SAMPLE_LOANS).DAI).toBe(0);
});

const open = buildProposal("p", { kind: "open", venueId: "morpho", asset: "ETH", amount: 8, borrow: 10000, safeId: "treasury", network: "ethereum" }, SAMPLE_LOANS);
it("open: outcome, Allow step, done", () => {
  expect(open.outcome).toBe("On Ethereum. You get 10,000 USDC and lock 8.00 ETH. Interest per year: $290 at 2.9%. Safe unless ETH falls below $1,453.");
  expect(open.steps).toEqual(["Allow Morpho Blue to use 8.00 ETH", "Lock 8.00 ETH in Morpho Blue", "Borrow 10,000 USDC"]);
  expect(open.title).toBe("Open a $10,000 Morpho Blue loan");
  expect(open.done.startsWith("Done. Your $10,000 Morpho Blue loan is open.")).toBe(true);
});
it("close aave: title and outcome", () => {
  const p = buildProposal("p", { kind: "close", loanId: "aave" }, SAMPLE_LOANS);
  expect(p.title).toBe("Close Aave v3 loan");
  expect(p.outcome).toBe("You pay back 18,215 USDC from the Safe and get back 14.50 wstETH.");
});
it("refi spark to morpho outcome", () => {
  const p = buildProposal("p", { kind: "refi", loanId: "spark", venueId: "morpho" }, SAMPLE_LOANS);
  for (const t of ["3.9% → 2.9%", "about $380 a year less", "$2,317 → $2,209", "Your debt changes from DAI to USDC."]) expect(p.outcome).toContain(t);
});
it("protect repay-only omits the zero collateral half", () => {
  expect(buildProposal("p", { kind: "protect", loanId: "spark", addColl: 0, repay: 5000 }, SAMPLE_LOANS).outcome).not.toContain("Uses 0");
});
it("testRunLine", () => {
  expect(testRunLine(1.89, loanFeeUsd(2745))).toEqual({ text: "Test run passed. Network fee about $11.", blocked: false });
  expect(testRunLine(1.2, loanFeeUsd(2745))).toEqual({ text: "Test run passed, but this is close to liquidation. Network fee about $11.", blocked: false });
  expect(testRunLine(0.95, 11).blocked).toBe(true);
  expect(testRunLine(null, 11).blocked).toBe(false);
  expect(testRunLine(1.89, 4).text).toBe("Test run passed. Network fee about $4.");
});
it("one fee owner: move fee is the quote's, outcome has no $, open fee is the loan fee", () => {
  const move = moveQuote("base", "ethereum", "ETH", 4.86);
  const mp = buildProposal("m", { kind: "move", safeId: "s", move, then: open.spec as never }, SAMPLE_LOANS);
  expect(mp.feeUsd).toBe(move.feeUsd);
  expect(mp.outcome).not.toContain("$");
  expect(open.steps.length).toBe(LOAN_STEPS);
  expect(open.feeUsd).toBeCloseTo(loanFeeUsd(PRICES.ETH));
});

it("seeded Morpho fix reaches the warn level", () => {
  const p = buildProposal("q1", { kind: "protect", loanId: "morpho", addColl: 0.1, repay: 0 }, SAMPLE_LOANS);
  expect(p.hfAfter!).toBeGreaterThanOrEqual(DEFAULT_LEVELS.warn);
});
it("open receipt says where the cash is", () => expect(open.done).toContain("10,000 USDC is in your Safe."));

it("stoppedLine says where a stopped proposal still is", () => {
  expect(stoppedLine(-1, false)).toBe("Rejected. Nothing was sent.");
  expect(stoppedLine(-1, true)).toBe("Rejected here. It is still in your Safe queue. Reject it in Safe too.");
  expect(stoppedLine(-3, false)).toBe("Out of date: the loan changed. Nothing was sent.");
  expect(stoppedLine(-3, true)).toBe("Out of date: the loan changed. It is still in your Safe queue. Reject it in Safe too.");
});

it("adding to the Morpho loan reads the shared quote", () => {
  const spec = { kind: "open", venueId: "morpho", asset: "WBTC", amount: 0.25, borrow: 10000, safeId: "treasury", network: "ethereum" } as const;
  const p = buildProposal("p", spec, SAMPLE_LOANS);
  const q = quoteLoan(VENUES.find((v) => v.id === "morpho")!, "WBTC", 0.25, 10000, PRICES.WBTC, SAMPLE_LOANS.filter((l) => l.safeId === "treasury"));
  expect(p.title).toBe("Add $10,000 to your Morpho Blue loan");
  expect(p.outcome).toContain("on the full $50,000 loan: $1,600 at 3.2%");
  expect(p.outcome).toContain("$50,556");
  expect(p.hfAfter).toBeCloseTo(q.hf);
  expect(p.done).toBe("Done. Added $10,000 to your Morpho Blue loan. It is now $50,000. 10,000 USDC is in your Safe. Health factor 1.48.");
});

it("advanceAction fixes the label of each signing step", () => {
  expect(advanceAction(0, 2)).toEqual({ label: "Send to Safe", variant: "default" });
  expect(advanceAction(1, 1)).toEqual({ label: "Sign in Safe (demo)", variant: "default" });
  expect(advanceAction(1, 2)).toEqual({ label: "Sign in Safe (demo)", variant: "default" });
  expect(advanceAction(2, 1)).toBeNull();
  expect(advanceAction(2, 2)).toEqual({ label: "Simulate co-signer", variant: "secondary" });
  expect([nextStage(1, 1), nextStage(1, 2), nextStage(0, 1), nextStage(2, 2)]).toEqual([3, 2, 1, 3]);
  expect(advanceAction(3, 2)).toBeNull();
  expect(advanceAction(-1, 2)).toBeNull();
});
