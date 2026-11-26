import { expect, it } from "vitest";
import { SAMPLE_LOANS } from "@/data";
import { specSafeId, threadOf } from "./threads";

it("a protect proposal belongs to its loan's Safe, not the active one", () => {
  expect(specSafeId({ kind: "protect", loanId: "spark", addColl: 1, repay: 0 }, SAMPLE_LOANS, "safe-1-abcd")).toBe("treasury");
});
it("an open proposal belongs to its own safeId", () => {
  expect(specSafeId({ kind: "open", venueId: "aave", asset: "ETH", amount: 1, borrow: 1, safeId: "safe-1-abcd", network: "ethereum" }, SAMPLE_LOANS, "treasury")).toBe("safe-1-abcd");
});
it("falls back when the loan is unknown", () => {
  expect(specSafeId({ kind: "close", loanId: "missing" }, SAMPLE_LOANS, "x")).toBe("x");
});
it("threadOf keeps only that Safe's messages in order", () => {
  const m = [{ id: "1", safeId: "a" }, { id: "2", safeId: "b" }, { id: "3", safeId: "a" }];
  expect(threadOf(m, "a").map((x) => x.id)).toEqual(["1", "3"]);
  expect(threadOf(m, "zz")).toEqual([]);
});

import { buildProposal } from "./proposals";
import { isStale, loanInContext } from "./threads";

const B0 = { ethereum: { ETH: 10, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 } }; // balances are per network
it("loanInContext finds the viewed loan and never crosses Safes", () => {
  expect(loanInContext(SAMPLE_LOANS, "treasury", "spark")?.id).toBe("spark");
  expect(loanInContext(SAMPLE_LOANS, "treasury", "")).toBeUndefined();
  expect(loanInContext(SAMPLE_LOANS, "safe-x", "spark")).toBeUndefined();
  const one = [{ ...SAMPLE_LOANS[0], safeId: "s1" }];
  expect(loanInContext(one, "s1", "")?.id).toBe(SAMPLE_LOANS[0].id);
  expect(loanInContext(SAMPLE_LOANS.filter((l) => l.id !== "aave"), "treasury", "aave")).toBeUndefined();
});
it("isStale checks the balance on the proposal's own network", () => {
  const o = buildProposal("p3", { kind: "open", venueId: "aave", asset: "ETH", amount: 4, borrow: 3000, safeId: "x", network: "base" }, []);
  expect(isStale(o, [], B0)).toBe(true);
  expect(isStale(o, [], { ...B0, base: { ...B0.ethereum, ETH: 5 } })).toBe(false);
});
it("isStale", () => {
  const p = buildProposal("p1", { kind: "close", loanId: "spark" }, SAMPLE_LOANS);
  expect(isStale(p, SAMPLE_LOANS, B0)).toBe(false);
  expect(isStale(p, SAMPLE_LOANS.filter((l) => l.id !== "spark"), B0)).toBe(true);
  expect(isStale(p, SAMPLE_LOANS.map((l) => (l.id === "spark" ? { ...l, collAmount: l.collAmount + 1 } : l)), B0)).toBe(true);
  const o = buildProposal("p2", { kind: "open", venueId: "morpho", asset: "ETH", amount: 8, borrow: 5000, safeId: "treasury", network: "ethereum" }, SAMPLE_LOANS.filter((l) => l.venue !== "Morpho Blue"));
  expect(isStale(o, SAMPLE_LOANS.filter((l) => l.venue !== "Morpho Blue"), B0)).toBe(false);
  expect(isStale(o, SAMPLE_LOANS.filter((l) => l.venue !== "Morpho Blue"), { ethereum: { ...B0.ethereum, ETH: 0 } })).toBe(true);
  const withM = [...SAMPLE_LOANS.filter((l) => l.venue !== "Morpho Blue"), { ...SAMPLE_LOANS[0], id: "m", safeId: "treasury", venue: "Morpho Blue", collAsset: "ETH" as const }];
  expect(isStale(o, withM, B0)).toBe(true);
});
