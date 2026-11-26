import { beforeEach, describe, expect, it } from "vitest";
import { usd } from "@/lib/format";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { createFixtureLenders } from "@/server/lenders/fixture";
import { borrowLimit, borrowLimitFor, liveInputs } from "@/server/market-inputs";
import { MOCK_COSIGNER, MOCK_EMPTY_SAFE, MOCK_OWNER, MOCK_SAFE } from "@/server/mock/seed";
import type { BlockCtx } from "./block-inputs";
import { readBlockData } from "./block-inputs";
import { getCashFor } from "./get-cash";
import { greetingFor } from "./greeting";
import { holdingsFor } from "./holdings";
import { whatIfFor } from "./whatif";

let reader: FixtureReader;
const ctx = (address: string): BlockCtx => ({
  services: { reader, lenders: createFixtureLenders() } as unknown as BlockCtx["services"],
  safe: { id: 1, address: address.toLowerCase(), name: "Main Safe" } as BlockCtx["safe"],
  networks: [],
  access: { ownedChainIds: [8453] } as BlockCtx["access"],
});

beforeEach(() => {
  reader = createFixtureReader();
  reader.setOwners(8453, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  reader.setBalances(8453, MOCK_SAFE, { ETH: 2.5 });
  reader.setOwners(8453, MOCK_EMPTY_SAFE, [MOCK_OWNER], 1);
  reader.setBalances(8453, MOCK_EMPTY_SAFE, {});
});

describe("one borrow limit (VC-02)", () => {
  it("greeting, Get cash and what-if use one limit", async () => {
    const c = ctx(MOCK_SAFE);
    const d = await readBlockData(c);
    const gc = await getCashFor(c, {});
    expect(d.max).toBe(gc.maxCash);
    expect(d.limit.max).toBe(gc.maxCash);
    expect((await whatIfFor(c)).cash).toBe(gc.maxCash);
    const g = await greetingFor(c);
    expect(g.max).toBe(gc.maxCash);
    expect(g.text).toContain(usd(gc.maxCash));
    expect(g.chips[0]).toBe(`Borrow ${usd(gc.maxCash)}`);
    expect(g.lenderId).toBe(d.limit.lenderId);
    expect(g.why).toContain(`Why ${usd(gc.maxCash)}?`);
  });

  it("the holdings row says the same number as the greeting, even when a lender prices the asset differently", async () => {
    const c = ctx(MOCK_SAFE);
    const rows = (await holdingsFor(c)).rows.filter((r) => r.asset === "ETH");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.max).toBe((await readBlockData(c)).max);
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE as `0x${string}`, createFixtureLenders());
    const skewed = { ...inputs, lenders: inputs.lenders.map((f) => ({ ...f, prices: { ...f.prices, ETH: (f.prices.ETH ?? inputs.prices.ETH) * 0.9 } })) };
    expect(borrowLimitFor(skewed, "ETH").max).toBe(borrowLimit(skewed).max);
    expect(borrowLimitFor(skewed, "ETH").max).toBeLessThan(borrowLimit(inputs).max);
  });

  it("borrowLimit names the lender and asset that give the max", async () => {
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE as `0x${string}`, createFixtureLenders());
    const l = borrowLimit(inputs);
    expect(l.max).toBeGreaterThan(500);
    expect(l.lenderId).not.toBeNull();
    expect(l.lenderName).toBeTruthy();
    expect(l.asset).toBe("ETH");
  });

  it("a lender whose limit is below its own minimum is not the default lender", async () => {
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE as `0x${string}`, createFixtureLenders());
    const top = borrowLimit(inputs);
    const lenders = inputs.lenders.map((f) => (f.id === top.lenderId ? { ...f, markets: { ...f.markets, [top.asset!]: { ...f.markets[top.asset!]!, minBorrow: top.max + 1 } } } : f));
    const next = borrowLimit({ ...inputs, lenders });
    expect(next.lenderId).not.toBe(top.lenderId);
    if (next.lenderId) expect(next.max).toBeGreaterThanOrEqual(10);
    expect(borrowLimit({ ...inputs, lenders: lenders.filter((f) => f.id === top.lenderId) })).toEqual({ max: 0, lenderId: null, lenderName: null, asset: null });
  });

  it("an empty Safe has a zero limit and no lender", async () => {
    const inputs = await liveInputs(reader, 8453, MOCK_EMPTY_SAFE as `0x${string}`, createFixtureLenders());
    expect(borrowLimit(inputs)).toEqual({ max: 0, lenderId: null, lenderName: null, asset: null });
  });
});
