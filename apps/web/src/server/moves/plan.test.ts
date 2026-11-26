import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { BASE_PRICES, NETWORKS, VENUES, type Venue } from "../../../tests/fixtures/legacy-data";
import { createSafe, deposit } from "@/lib/networks";
import { moveReason } from "@/lib/cash-plan";
import { planCrossNetwork } from "./plan";
import { fakeAggregator } from "./testing";
import { SAFE } from "@/server/mock/moves-fixtures/status";
import type { Address } from "@/shared/types";
import type { AggregatorQuote, BridgeAggregator, QuoteParams } from "./types";

const owner = { address: "0x7be2a91c4d05f3e8b6a7c1d92e04f58a3b6cc41a", ownerCount: 1, threshold: 1 };
const empty = createSafe({ id: "s", name: "S", ...owner, networks: ["ethereum", "base"] });
const onBase = deposit(empty, "base", { ETH: 5 });
const need = (cash: number) => ({ cash, months: 12, targetHf: 1.6, asset: "ETH" as const, network: "base" as const });
const run = (cash: number, venues: readonly Venue[], aggregator: BridgeAggregator = fakeAggregator({ feeUsd: 4, ratio: 0.995 })) =>
  planCrossNetwork({ aggregator, networks: NETWORKS, chainOf: (n) => (n === "base" ? 8453 : 1) }, { safe: onBase, safeAddress: getAddress(SAFE), need: need(cash), prices: BASE_PRICES, venues, loans: [] });
const pricey: Venue[] = [
  { ...VENUES[0], id: "here", name: "Here", apr: 8, networks: ["base"] },
  { ...VENUES[0], id: "there", name: "There", apr: 2, networks: ["ethereum"] },
];

describe("BP-36 cross-network plan with a real quote", () => {
  it("adds the move row and the reason sentence when no lender on the collateral's network can fund it", async () => {
    const r = (await run(7500, VENUES))!;
    expect(r.choice.plan.network).toBe("ethereum");
    expect(r.choice.plan.venue.id).toBe("compound");
    expect(r.reason).toBe("No lender on Base can lend $7,500 against your ETH at this safety level. Compound v3 on Ethereum can, so your ETH moves there first.");
    expect(r.reason).toBe(moveReason(r.choice.plan, r.plans, NETWORKS));
  });
  it("takes the fee and the time from the quote, and plans the loan on the minimum received", async () => {
    const r = (await run(7500, VENUES))!;
    const m = r.choice.plan.move!;
    expect(m.feeUsd).toBe(4);
    expect(m.minutes).toBe(r.quote!.durationSec >= 60 ? Math.ceil(r.quote!.durationSec / 60) : 1);
    const minUnits = Number(r.quote!.toAmountMin) / 1e18;
    expect(r.choice.plan.collateral).toBeCloseTo(minUnits, 6); // the loan is sized on what is guaranteed to arrive
    expect(m.amount).toBeGreaterThan(r.choice.plan.collateral); // so the move sends a little more than the loan locks
    expect(r.quote!.fromAmount).toBe(BigInt(Math.round(m.amount * 100)) * 10n ** 16n);
    expect(r.choice.plan.hf).toBeGreaterThanOrEqual(1.6 - 0.02);
    expect(r.then).toMatchObject({ kind: "open", venueId: "compound", asset: "ETH", amount: r.choice.plan.collateral, borrow: 7500, network: "ethereum" });
  });
  it("offers a cheaper cross-network plan only when it saves more a year than the move costs", async () => {
    const r = (await run(3000, pricey))!;
    expect(r.choice.plan.venue.id).toBe("here");
    expect(r.choice.alternative!.plan.venue.id).toBe("there");
    expect(r.choice.alternative!.saves).toBeGreaterThan(4);
    expect(r.alternativeQuote).toBeDefined();
    const close = pricey.map((v) => (v.id === "there" ? { ...v, apr: 7.99 } : v));
    expect((await run(3000, close))!.choice.alternative).toBeUndefined();
  });
  it("offers no move plan when the aggregator has no route for that asset and pair", async () => {
    const none = fakeAggregator({ noRoute: true });
    expect(await run(7500, VENUES, none)).toBeNull();
    const same = (await run(3000, pricey, none))!;
    expect(same.choice.plan.move).toBeUndefined();
    expect(same.choice.alternative).toBeUndefined();
  });
  it("does not call the aggregator when a lender on the same network can fund it and nothing could be cheaper", async () => {
    const agg = fakeAggregator({});
    const spy = vi.spyOn(agg, "quote");
    const r = (await run(3000, VENUES.map((v) => ({ ...v, networks: ["base" as const] })), agg))!;
    expect(r.choice.plan.move).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

const WBTC_MAINNET = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const OTHER_SAFE = "0x9f8da0c9d4a1c6f92e7b51d30a8e2c04f6b37d12" as Address;

/** An aggregator whose quotes are rewritten after the inner one answers: `only` picks which calls get the bad answer. */
const answering = (inner: BridgeAggregator, patch: (q: AggregatorQuote) => AggregatorQuote, only?: (call: number) => boolean): BridgeAggregator => {
  let calls = 0;
  return {
    quote: async (p: QuoteParams) => {
      const i = calls++;
      const q = await inner.quote(p);
      return q && (only === undefined || only(i)) ? patch(q) : q;
    },
    status: inner.status,
  };
};

describe("a quote that answers a different request than it was asked", () => {
  const wrong: Record<string, (q: AggregatorQuote) => AggregatorQuote> = {
    "source network": (q) => ({ ...q, fromChain: 10 }),
    "destination network": (q) => ({ ...q, toChain: 10 }),
    "source token": (q) => ({ ...q, fromToken: WBTC_MAINNET }),
    "destination token": (q) => ({ ...q, toToken: WBTC_MAINNET }),
    "source token decimals": (q) => ({ ...q, fromDecimals: 8 }),
    "destination token decimals": (q) => ({ ...q, toDecimals: 8 }),
    "source amount": (q) => ({ ...q, fromAmount: q.fromAmount + 1n }),
    "sending address": (q) => ({ ...q, fromAddress: OTHER_SAFE }),
    "recipient address": (q) => ({ ...q, toAddress: OTHER_SAFE }),
  };
  for (const [field, patch] of Object.entries(wrong)) {
    it(`yields no move plan when every answer carries a different ${field}`, async () => {
      expect(await run(7500, VENUES, answering(fakeAggregator({}), patch))).toBeNull();
    });
    // The pricey fixture leaves exactly one move plan, so its calls are: 0 = the probe, 1 = the quote for the sized send.
    it(`rejects at the probe when the first answer carries a different ${field}`, async () => {
      const inner = fakeAggregator({});
      const r = (await run(3000, pricey, answering(inner, patch, (i) => i === 0)))!;
      expect(r.plans.every((p) => !p.move)).toBe(true);
      expect(r.choice.alternative).toBeUndefined();
      expect(r.alternativeQuote).toBeUndefined();
      expect(inner.quotes).toHaveLength(1); // refused at the probe: the final ask never ran
    });
    it(`rejects at the final quote when the sized answer carries a different ${field}`, async () => {
      const inner = fakeAggregator({});
      const r = (await run(3000, pricey, answering(inner, patch, (i) => i === 1)))!;
      expect(r.plans.every((p) => !p.move)).toBe(true);
      expect(r.choice.alternative).toBeUndefined();
      expect(r.alternativeQuote).toBeUndefined();
      expect(inner.quotes).toHaveLength(2); // the probe passed; the bad answer to the sized ask failed
    });
  }
  it("still plans the move when every answer echoes its request", async () => {
    const r = (await run(3000, pricey))!;
    expect(r.choice.alternative!.plan.move).toBeDefined();
    expect(r.alternativeQuote).toBeDefined();
  });
});
