import { expect, it } from "vitest";
import { BALANCES, SAMPLE_LOANS, BASE_PRICES, TEST_PROPOSAL_INPUTS, VENUES } from "../../tests/fixtures/legacy-data";
import { DEFAULT_LEVELS } from "./loan-math";
import { quoteLoan } from "./cash-plan";
import { balancesAfter, buildProposal, stoppedLine } from "./proposals";

const build = (id: string, spec: Parameters<typeof buildProposal>[1], loans: typeof SAMPLE_LOANS) =>
  buildProposal(id, spec, loans, TEST_PROPOSAL_INPUTS);
const after = (balances: typeof BALANCES, spec: Parameters<typeof balancesAfter>[1], loans: typeof SAMPLE_LOANS) =>
  balancesAfter(balances, spec, loans, VENUES);

it("open moves collateral out and the borrowed stablecoin in, without mutating the input", () => {
  const before = { ...BALANCES };
  const a = after(BALANCES, { kind: "open", venueId: "morpho", asset: "ETH", amount: 8, borrow: 10000, safeId: "treasury", network: "ethereum" }, SAMPLE_LOANS);
  expect(a.ETH).toBe(0);
  expect(a.USDC).toBe(55000);
  expect(BALANCES).toEqual(before);
});
it("close returns collateral and pays debt plus accrued interest", () => {
  const a = after(BALANCES, { kind: "close", loanId: "spark" }, SAMPLE_LOANS);
  expect(a.ETH).toBe(28);
  expect(a.DAI).toBeCloseTo(40000 - 38388.1);
});
it("protect spends collateral and repayment", () => {
  const a = after(BALANCES, { kind: "protect", loanId: "spark", addColl: 2, repay: 5000 }, SAMPLE_LOANS);
  expect(a.ETH).toBe(6);
  expect(a.DAI).toBe(35000);
});
it("clamps at 0", () => {
  expect(after(BALANCES, { kind: "protect", loanId: "spark", addColl: 0, repay: 99999 }, SAMPLE_LOANS).DAI).toBe(0);
});

const open = build("p", { kind: "open", venueId: "morpho", asset: "ETH", amount: 8, borrow: 10000, safeId: "treasury", network: "ethereum" }, SAMPLE_LOANS);
it("open: outcome, Allow step, done", () => {
  expect(open.outcome).toBe("On Ethereum. You get 10,000 USDC and lock 8.00 ETH. Interest per year: $290 at 2.9%. The lender could sell some of your ETH if its price falls to about $1,453 (47% below today's $2,745).");
  expect(open.steps).toEqual(["Allow Morpho Blue to use 8.00 ETH", "Lock 8.00 ETH in Morpho Blue", "Borrow 10,000 USDC"]);
  expect(open.title).toBe("Open a $10,000 Morpho Blue loan");
  expect(open.done.startsWith("Done. Your $10,000 Morpho Blue loan is open.")).toBe(true);
});
it("close aave: title and outcome", () => {
  const p = build("p", { kind: "close", loanId: "aave" }, SAMPLE_LOANS);
  expect(p.title).toBe("Close Aave v3 loan");
  expect(p.outcome).toBe("You pay back 18,215 USDC from the Safe and get back 14.50 wstETH.");
});
it("protect repay-only omits the zero collateral half", () => {
  expect(build("p", { kind: "protect", loanId: "spark", addColl: 0, repay: 5000 }, SAMPLE_LOANS).outcome).not.toContain("Uses 0");
});
it("adds the injected bridge quote and network fee estimate", () => {
  const move = { from: "base" as const, to: "ethereum" as const, asset: "ETH" as const, amount: 4.86, feeUsd: 37, minutes: 91 };
  const mp = build("m", { kind: "move", safeId: "s", move, then: open.spec as never }, SAMPLE_LOANS);
  expect(mp.feeUsd).toBe(48);
  expect(mp.outcome).not.toContain("$");
  expect(open.steps.length).toBe(3);
  expect(open.feeUsd).toBe(11);
});

it("seeded Morpho fix reaches the warn level", () => {
  const p = build("q1", { kind: "protect", loanId: "morpho", addColl: 0.1, repay: 0 }, SAMPLE_LOANS);
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
  const p = build("p", spec, SAMPLE_LOANS);
  const q = quoteLoan(VENUES.find((v) => v.id === "morpho")!, "WBTC", 0.25, 10000, BASE_PRICES.WBTC, SAMPLE_LOANS.filter((l) => l.safeId === "treasury"));
  expect(p.title).toBe("Add $10,000 to your Morpho Blue loan");
  expect(p.outcome).toContain("on the full $50,000 loan: $1,600 at 3.2%");
  expect(p.outcome).toContain("$50,556");
  expect(p.hfAfter).toBeCloseTo(q.hf);
  expect(p.done).toBe("Done. Added $10,000 to your Morpho Blue loan. It is now $50,000. 10,000 USDC is in your Safe. Health factor 1.48.");
});
