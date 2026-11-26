import { afterEach, describe, expect, it } from "vitest";
import { createTestWorld } from "../../tests/helpers/world";
import { MOCK_SAFE } from "@/server/mock/seed";
import { tokenBySymbol } from "@/server/chain/config";
import type { LoanPosition } from "@/shared/types";
import { loanLevels } from "@/server/db/schema";
import { quotePlan } from "./quote";

describe("quotePlan (fixture reader)", () => {
  let world: Awaited<ReturnType<typeof createTestWorld>>;
  afterEach(() => world?.reset());
  const setup = async () => {
    world = await createTestWorld();
    const id = await world.trackSafe(MOCK_SAFE);
    return { id, ctx: { db: world.db, services: world.services, safe: { id, address: MOCK_SAFE.toLowerCase() } }, fx: world.services.fixture };
  };
  const position = (over: Partial<LoanPosition> = {}): LoanPosition => ({
    chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
    collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
    debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
    healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n, ...over,
  });

  it("I need $5,000: every row, the Test run line, one block number", async () => {
    const { ctx, fx } = await setup();
    fx.setBalances(8453, MOCK_SAFE, { ETH: 4 });
    const r = await quotePlan(ctx, { cash: 5000, messageId: "m1" });
    expect(r.status).toBe("ok");
    expect(r.cash).toBe(5000);
    expect(r.cappedNote).toBeUndefined();
    expect(r.blockNumber).toBe(57_172_000);
    if (r.quote.kind !== "ok") throw new Error("expected ok");
    expect(r.quote).toMatchObject({ cash: 5000, borrowAsset: "USDC", asset: "ETH", lender: "Aave v3", network: "Base", adding: false });
    expect(r.quote.collateral).toBeGreaterThan(1);
    expect(r.quote.liqPrice).toBeGreaterThan(0);
    expect(r.quote.dropPct).toBeGreaterThan(0);
    expect(r.quote.yearly).toBeCloseTo((5000 * r.quote.apr) / 100, 0);
    expect(r.quote.feesLine).toMatch(/^One-time network fee: about \$/);
    expect(r.costLine).toBeUndefined();
    expect(r.testRun.canSend).toBe(true);
    expect(r.testRun.line).toMatch(/^Checked: this would work/);
    expect(r.draft.live).toBe(true);
    expect(r.draft.draftKey).toBeTruthy();
  });

  it("above the maximum starts at the maximum with the exact note", async () => {
    const { ctx } = await setup();
    const r = await quotePlan(ctx, { cash: 50_000 });
    expect(r.status).toBe("ok");
    expect(r.cash).toBeLessThan(50_000);
    expect(r.cash).toBe(r.maxCash);
    expect(r.cappedNote).toBe(`Capped at $${r.maxCash!.toLocaleString("en-US")}, the most this Safe can borrow.`);
  });

  it("liquidity too low: not feasible, with the reason", async () => {
    const { ctx, fx } = await setup();
    fx.setBalances(8453, MOCK_SAFE, { ETH: 4 });
    const usdc = tokenBySymbol(8453, "USDC")!.address!;
    const m = (await fx.readAaveMarket(8453, usdc)).market;
    fx.setMarket(8453, { ...m, availableLiquidity: 1000 });
    const r = await quotePlan(ctx, { cash: 5000 });
    expect(r.status).toBe("notFeasible");
    expect(r.quote).toMatchObject({ kind: "notFeasible" });
    expect(r.testRun.canSend).toBe(false);
    expect(r.testRun.reason).toMatch(/can lend only about \$1,000/);
  });

  it("a borrow cap that is already used: not feasible", async () => {
    const { ctx, fx } = await setup();
    fx.setBalances(8453, MOCK_SAFE, { ETH: 4 });
    const usdc = tokenBySymbol(8453, "USDC")!.address!;
    const m = (await fx.readAaveMarket(8453, usdc)).market;
    fx.setMarket(8453, { ...m, borrowCap: 3000 });
    expect((await quotePlan(ctx, { cash: 5000 })).status).toBe("notFeasible");
  });

  it("a frozen market: not feasible with the reason", async () => {
    const { ctx, fx } = await setup();
    const usdc = tokenBySymbol(8453, "USDC")!.address!;
    fx.setMarket(8453, { ...(await fx.readAaveMarket(8453, usdc)).market, isFrozen: true });
    const r = await quotePlan(ctx, { cash: 5000 });
    expect(r.status).toBe("notFeasible");
    expect(r.testRun.reason).toMatch(/paused or frozen/);
  });

  it("an existing loan at the same lender and asset: figures for the full loan, and it says so", async () => {
    const { ctx, fx } = await setup();
    fx.setPosition(8453, MOCK_SAFE, position());
    const r = await quotePlan(ctx, { cash: 2000, asset: "ETH" });
    expect(r.status).toBe("ok");
    if (r.quote.kind !== "ok") throw new Error("expected ok");
    expect(r.quote.adding).toBe(true);
    expect(r.costLine).toContain("on the full $3,000 loan");
    expect(r.quote.yearly).toBeCloseTo((3000 * r.quote.apr) / 100, 0);
  });

  it("an account with another collateral: not available for this Safe yet, no figures", async () => {
    const { ctx, fx } = await setup();
    fx.setPosition(8453, MOCK_SAFE, position({ mixed: true }));
    const r = await quotePlan(ctx, { cash: 2000 });
    expect(r.status).toBe("unavailable");
    expect(r.quote).toEqual({ kind: "unavailable" });
    expect(r.testRun).toMatchObject({ canSend: false, reason: "not available for this Safe yet" });
    // A wstETH plan on an account whose collateral is ETH is the same.
    fx.setPosition(8453, MOCK_SAFE, position());
    fx.setBalances(8453, MOCK_SAFE, { ETH: 2.5, wstETH: 5 });
    expect((await quotePlan(ctx, { cash: 2000, asset: "wstETH" })).status).toBe("unavailable");
  });

  it("a Safe with nothing to borrow against: not feasible", async () => {
    const { ctx, fx } = await setup();
    fx.setBalances(8453, MOCK_SAFE, { ETH: 0 });
    const r = await quotePlan(ctx, { cash: 5000 });
    expect(r.status).toBe("notFeasible");
    expect(r.quote).toMatchObject({ kind: "notFeasible" });
  });

  it("a failing test run disables Send with the reason", async () => {
    const { ctx } = await setup();
    const failing = { ...ctx, services: { ...ctx.services, testRunDeps: { ...ctx.services.testRunDeps, simulate: async () => ({ ok: false, failedStep: 3, healthAfter: null, totalCollateralBase: 0n, totalDebtBase: 0n, gasUsed: 0n, feeUsd: 0 }) } } };
    const r = await quotePlan(failing, { cash: 5000 });
    expect(r.status).toBe("ok");
    expect(r.testRun.canSend).toBe(false);
    expect(r.testRun.reason).toMatch(/failed at "Borrow/);
  });

  it("safer levels lock more", async () => {
    const { ctx } = await setup();
    const a = await quotePlan(ctx, { cash: 3000, hfIdx: 0 });
    const b = await quotePlan(ctx, { cash: 3000, hfIdx: 2 });
    if (a.quote.kind !== "ok" || b.quote.kind !== "ok") throw new Error("expected ok");
    expect(a.quote.collateral).toBeGreaterThan(b.quote.collateral);
  });

  describe("the At-risk warning uses the loan's saved levels (BP-19)", () => {
    const withHealthAfter = (ctx: Awaited<ReturnType<typeof setup>>["ctx"], healthAfter: number) => ({
      ...ctx, services: { ...ctx.services, testRunDeps: { ...ctx.services.testRunDeps, simulate: async (p: Parameters<typeof ctx.services.testRunDeps.simulate>[0]) => ({ ...(await ctx.services.testRunDeps.simulate(p)), healthAfter }) } },
    });
    it("saved At-risk 2.0 and simulated health 1.8: the Test run warns", async () => {
      const { ctx, fx, id } = await setup();
      fx.setPosition(8453, MOCK_SAFE, position());
      await ctx.db.insert(loanLevels).values({ safeId: id, loanId: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`, chainId: 8453, warn: 2.5, act: 2.0 });
      const r = await quotePlan(withHealthAfter(ctx, 1.8), { cash: 2000, asset: "ETH" });
      expect(r.testRun.canSend).toBe(true);
      expect(r.testRun.line).toMatch(/close to liquidation/);
    });
    it("a brand-new loan uses the default levels", async () => {
      const { ctx } = await setup();
      const r = await quotePlan(withHealthAfter(ctx, 1.8), { cash: 2000 });
      expect(r.testRun.line).not.toMatch(/close to liquidation/);
    });
  });
});
