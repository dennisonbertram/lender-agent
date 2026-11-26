import { describe, expect, it } from "vitest";
import { BASE_PRICES, NETWORKS, SAMPLE_LOANS, TREASURY, VENUES } from "./fixtures/legacy-data";
import type { Safe, Venue } from "./fixtures/legacy-data";
import { plansAcross, type BridgeQuote } from "../src/lib/cash-plan";
import { compute, type ProposalInputs } from "../src/lib/proposals";

describe("explicit real-data dependencies", () => {
  it("uses each call's markets, prices, network names and fee estimate without state bleed", () => {
    const spec = { kind: "open", venueId: "morpho", asset: "ETH", amount: 8, borrow: 10_000, safeId: "treasury", network: "ethereum" } as const;
    const venueA = VENUES.map((venue) => venue.id === "morpho" ? { ...venue, markets: { ...venue.markets, ETH: { maxLtv: 0.7, lt: 0.72 } } } : venue);
    const venueB = VENUES.map((venue) => venue.id === "morpho" ? { ...venue, markets: { ...venue.markets, ETH: { maxLtv: 0.5, lt: 0.55 } } } : venue);
    const inputsA: ProposalInputs = { prices: { ...BASE_PRICES, ETH: 1_000 }, venues: venueA, networks: [{ id: "ethereum", name: "Alpha" }], feeEstimateUsd: 4 };
    const inputsB: ProposalInputs = { prices: { ...BASE_PRICES, ETH: 2_000 }, venues: venueB, networks: [{ id: "ethereum", name: "Beta" }], feeEstimateUsd: 19 };

    const first = compute(spec, SAMPLE_LOANS, inputsA);
    const second = compute(spec, SAMPLE_LOANS, inputsB);

    expect(first.feeUsd).toBe(4);
    expect(second.feeUsd).toBe(19);
    expect(first.outcome).toContain("Alpha");
    expect(second.outcome).toContain("Beta");
    expect(first.outcome).not.toBe(second.outcome);
    expect(second.hfAfter).toBeGreaterThan(first.hfAfter!);
    expect(compute(spec, SAMPLE_LOANS, inputsA)).toEqual(first);
  });

  it("uses the injected bridge quote instead of a built-in fee or duration", () => {
    const safe: Safe = {
      ...TREASURY,
      networks: [{ id: "base", deployed: true, agent: true }, { id: "ethereum", deployed: true, agent: false }],
      balances: { base: TREASURY.balances.ethereum! },
    };
    const venue: Venue = { ...VENUES[0], networks: ["ethereum"] };
    const networks = [{ id: "base" as const, name: "Base" }, { id: "ethereum" as const, name: "Ethereum" }];
    const bridgeQuote: BridgeQuote = (from, to, asset, amount) => ({ from, to, asset, amount, feeUsd: 37, minutes: 91 });
    const plans = plansAcross(safe, { network: "base", cash: 5_000, months: 12, targetHf: 1.6, asset: "ETH" }, BASE_PRICES, [venue], [], networks, bridgeQuote);

    expect(plans[0]?.move).toEqual(expect.objectContaining({ feeUsd: 37, minutes: 91 }));
    expect(plans[0]?.move?.amount).toBe(plans[0]?.collateral);
    expect(plansAcross(safe, { network: "base", cash: 5_000, months: 12, targetHf: 1.6, asset: "ETH" }, BASE_PRICES, [venue], [], [], bridgeQuote)).toEqual([]);
  });

  it("rejects an unknown market source instead of borrowing sample data", () => {
    expect(() => compute({ kind: "open", venueId: "missing", asset: "ETH", amount: 1, borrow: 1, safeId: "s", network: "ethereum" }, [], {
      prices: BASE_PRICES, venues: [], networks: NETWORKS, feeEstimateUsd: 1,
    })).toThrow("Unknown venue: missing");
  });
});
