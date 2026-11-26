// BP-33 and BP-34, server side, on the fixture world: the quote, compare, what-if and Get cash functions
// across Aave, Compound v3 and Morpho (VC-02, M4 exit 2). The fork test is tests/integration/lenders-quote-fork.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BALANCED_HF } from "@/lib/loan-math";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { eq } from "drizzle-orm";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { proposals, planDrafts } from "@/server/db/schema";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import type { Hex, LoanPosition } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../tests/helpers/world";
import { COMET_USDC_BASE, MORPHO_WETH_USDC_ID } from "@/server/lenders/allowlist";
import type { FixtureLenders } from "@/server/lenders/fixture";
import type { AdapterPosition, MarketRef } from "@/server/lenders/types";
import { compareFor } from "@/server/blocks/compare";
import { getCashFor } from "@/server/blocks/get-cash";
import { whatIfFor } from "@/server/blocks/whatif";
import { statusFor } from "@/server/blocks/status";
import { explainFor } from "@/server/blocks/explain";
import { quotePlan } from "@/server/quote";
import { sendToSafe } from "@/server/proposals/send";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const COMPOUND: MarketRef = { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" };
const MORPHO: MarketRef = { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC_ID, collateral: "WETH" };

let w: TestWorld;
let id: number;
let lenders: FixtureLenders;
let ctx: Awaited<ReturnType<typeof safeContext>>;
const qctx = () => ({ db: w.db, services: w.services, safe: { id, address: MOCK_SAFE.toLowerCase() } });

beforeEach(async () => {
  w = await createTestWorld();
  id = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  lenders = w.services.lenders as FixtureLenders;
  w.services.fixture.setBalances(8453, MOCK_SAFE, { ETH: 8 });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await w.services.fakes.get(8453)!.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => w.reset());

describe("the smallest loan: the app's $10, and a lender's own minimum on top", () => {
  it("Aave and Morpho have no minimum of their own: $20 is a plan for $20", async () => {
    for (const venueId of ["aave-v3", "morpho-blue"]) {
      const r = await quotePlan(qctx(), { cash: 20, venueId });
      expect(r.status).toBe("ok");
      expect(r.cash).toBe(20);
      expect(r.cappedNote).toBeUndefined();
    }
  });

  it("Compound's baseBorrowMin (100 in the fixture) is not silently applied: $20 moves to a lender that allows it, and the note says so (production: $20 became $195)", async () => {
    const r = await quotePlan(qctx(), { cash: 20, venueId: "compound-v3" });
    expect(r.status).toBe("ok");
    expect(r.cash).toBe(20);
    expect(r.venueId).not.toBe("compound-v3");
    expect(r.cappedNote).toMatch(/^The smallest Compound v3 loan is \$100; .+ allows \$20, so this plan uses /);
  });

  it("a lender the owner chose is kept: $20 on Compound is the minimum note, not a switch", async () => {
    const r = await quotePlan(qctx(), { cash: 20, venueId: "compound-v3", venueChosen: true });
    expect(r.status).toBe("notFeasible");
    expect(r.venueId).toBe("compound-v3");
    expect(r.testRun.canSend).toBe(false);
    if (r.quote.kind !== "notFeasible") throw new Error("expected notFeasible");
    expect(r.quote.reason).toBe("The smallest Compound v3 loan is $100.");
  });

  it("a chosen lender that does not exist is refused (409), not swapped for Aave", async () => {
    await expect(quotePlan(qctx(), { cash: 500, venueId: "nope-v9", venueChosen: true })).rejects.toMatchObject({ status: 409 });
  });

  it("a hypothetical size is the collateral for that amount, not capped to what the Safe can borrow, and cannot be sent", async () => {
    const r = await quotePlan(qctx(), { cash: 100_000, venueId: "compound-v3", hypothetical: true });
    expect(r.status).toBe("ok");
    expect(r.cash).toBe(100_000);
    expect(r.testRun.canSend).toBe(false);
    expect(r.cappedNote).toBeUndefined();
    if (r.quote.kind !== "ok") throw new Error("expected ok");
    expect(r.quote.collateralUsd).toBeGreaterThan(100_000);
  });

  it("a normal plan far above the Safe is still capped", async () => {
    const r = await quotePlan(qctx(), { cash: 100_000, venueId: "aave-v3" });
    expect(r.cash).toBeLessThan(100_000);
  });
});

describe("quotePlan picks the lender by venue", () => {
  it("defaults to Aave, as in M1", async () => {
    const r = await quotePlan(qctx(), { cash: 2000 });
    expect(r.venueId).toBe("aave-v3");
    expect(r.quote).toMatchObject({ kind: "ok", lender: "Aave v3", apr: 5.5 });
  });

  it.each([["compound-v3", "Compound v3", 4.2], ["morpho-blue", "Morpho", 3.4]])("%s: its own rate, its own parameters, and a Test run that passes", async (venueId, name, apr) => {
    const r = await quotePlan(qctx(), { cash: 2000, venueId });
    expect(r.status).toBe("ok");
    expect(r.venueId).toBe(venueId);
    if (r.quote.kind !== "ok") throw new Error("expected ok");
    expect(r.quote).toMatchObject({ lender: name, apr, asset: "ETH" });
    expect(r.quote.yearly).toBeCloseTo((2000 * apr) / 100, 6);
    expect(r.testRun.canSend).toBe(true);
    expect(r.testRun.line).toMatch(/^Checked: this would work/);
  });

  it("Morpho does not take wstETH: not feasible, says what it takes", async () => {
    const r = await quotePlan(qctx(), { cash: 2000, venueId: "morpho-blue", asset: "wstETH" });
    expect(r.status).toBe("notFeasible");
    expect(r.testRun.reason).toBe("Morpho on Base does not take wstETH as collateral. It takes ETH.");
  });

  it("a lender that cannot be read is not available; the others still quote", async () => {
    lenders.fail("compound-v3");
    const bad = await quotePlan(qctx(), { cash: 2000, venueId: "compound-v3" });
    expect(bad.status).toBe("notFeasible");
    expect(bad.testRun.reason).toMatch(/could not be read right now/);
    expect((await quotePlan(qctx(), { cash: 2000, venueId: "morpho-blue" })).status).toBe("ok");
  });
});

describe("Send works for each allowed lender through its adapter", () => {
  it.each(["aave-v3", "compound-v3", "morpho-blue"])("%s: queued, with the lender's own calls and the plan's words", async (venueId) => {
    const q = await quotePlan({ ...qctx(), messageId: undefined } as never, { cash: 2000, venueId, messageId: "m1" });
    expect(q.status).toBe("ok");
    if (q.quote.kind !== "ok") throw new Error("expected ok");
    const r = await sendToSafe(ctx, { draftKey: q.draft.draftKey!, chainId: 8453, cash: 2000, venueId, hfIdx: 1 });
    expect(r.stage).toBe("queued");
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect((row.spec as { venueId: string }).venueId).toBe(venueId);
    // The proposal card's words carry the plan card's rate, yearly cost and liquidation price.
    expect(row.outcome).toContain(`$${q.quote.yearly.toLocaleString("en-US", { maximumFractionDigits: 0 })} at ${q.quote.apr}%`);
    expect(row.outcome).toContain(`The lender could sell some of your ETH if its price falls to about $${Math.round(q.quote.liqPrice).toLocaleString("en-US")}`);
    expect(row.steps.join(" ")).toContain(venueId === "aave-v3" ? "Aave v3" : venueId === "morpho-blue" ? "Morpho" : "Compound v3");
    expect(r.receipt).toContain(venueId === "aave-v3" ? "Aave v3" : venueId === "morpho-blue" ? "Morpho" : "Compound v3");
    void planDrafts;
  });
});

describe("compare (BP-33)", () => {
  it("one row per lender, cheapest first, one block number, with the plan card's figures", async () => {
    const c = await compareFor(ctx, { cash: 5000 });
    expect(c.rows.map((r) => r.venueId)).toEqual(["morpho-blue", "compound-v3", "aave-v3"]);
    expect(c.cheapest).toBe("morpho-blue");
    expect(c.blockNumber).toBe(57_172_000);
    for (const r of c.rows) {
      const q = await quotePlan(qctx(), { cash: 5000, venueId: r.venueId, asset: c.asset });
      if (q.quote.kind !== "ok") throw new Error("expected ok");
      expect(r).toMatchObject({ feasible: true, apr: q.quote.apr, yearly: q.quote.yearly, dropPct: q.quote.dropPct, liqPrice: q.quote.liqPrice });
    }
  });

  it("a lender that cannot fund the amount is muted with what it can lend (r33)", async () => {
    lenders.setMarket(MORPHO, { availableLiquidity: 1_000 });
    const c = await compareFor(ctx, { cash: 5000 });
    const m = c.rows.find((r) => r.venueId === "morpho-blue")!;
    expect(m.feasible).toBe(false);
    expect(m.reason).toMatch(/can lend only about \$1,000/);
    expect(c.rows.at(-1)!.venueId).toBe("morpho-blue"); // infeasible rows come last
    expect(c.cheapest).toBe("compound-v3");
  });

  it("more than the Safe holds: every row says 'Can lend up to $X against your ETH.'", async () => {
    const c = await compareFor(ctx, { cash: 60_000, asset: "ETH" });
    expect(c.rows.every((r) => !r.feasible)).toBe(true);
    for (const r of c.rows) expect(r.reason).toMatch(/^Can lend up to \$[\d,]+ against your ETH\.$/);
  });

  it("a lender that cannot be read is listed as not available; the rest compare", async () => {
    lenders.fail("morpho-blue");
    const c = await compareFor(ctx, { cash: 5000 });
    expect(c.rows.find((r) => r.venueId === "morpho-blue")).toMatchObject({ feasible: false });
    expect(c.rows.filter((r) => r.feasible).map((r) => r.venueId)).toEqual(["compound-v3", "aave-v3"]);
  });
});

describe("what-if (BP-33)", () => {
  const position = (over: Partial<LoanPosition> = {}): LoanPosition => ({
    chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
    collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
    debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
    healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n, ...over,
  });

  it("each loan's health and status at every step, from the lender's own health", async () => {
    w.services.fixture.setPosition(8453, MOCK_SAFE, position());
    const r = await whatIfFor({ ...ctx, db: w.db }, { asset: "ETH" });
    expect(r.loans).toHaveLength(1);
    const steps = r.loans[0].steps;
    expect(steps[0]).toMatchObject({ drop: 0, hf: 2.49, status: "healthy" });
    expect(steps.find((s) => s.drop === 30)!.hf).toBeCloseTo(2.49 * 0.7, 9);
    expect(steps.find((s) => s.drop === 60)!.status).toBe("liquidatable");
    expect(r.hypothetical).toBeNull();
  });

  it("the status block lists a Morpho loan (R1: it said \"no loans yet\" while the sidebar showed the loan)", async () => {
    lenders.setPosition(MORPHO, SAFE, {
      lender: "morpho-blue", chainId: 8453, safe: SAFE, marketId: MORPHO.marketId, collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 2, usd: 6000 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }], health: 1.7, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 1n,
    });
    const s = await statusFor({ ...ctx, db: w.db });
    expect(s.loans).toHaveLength(1);
    expect(s.loans[0]).toMatchObject({ venue: "Morpho", hf: 1.7, status: "healthy", id: `8453:${SAFE.toLowerCase()}:morpho-blue` });
    expect(s.sentence).not.toBe("");
  });

  it("the explainer names the lender the owner would use, not always Aave (F-07)", async () => {
    const a = await explainFor({ ...ctx, db: w.db }, "how");
    expect(a.lender).toBeTruthy();
    lenders.setPosition(MORPHO, SAFE, {
      lender: "morpho-blue", chainId: 8453, safe: SAFE, marketId: MORPHO.marketId, collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 2, usd: 6000 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }], health: 1.7, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 1n,
    });
    expect((await explainFor({ ...ctx, db: w.db }, "how")).lender).toBe("Morpho");
  });

  it("a Compound or Morpho loan is a row too, with its own health", async () => {
    const pos = (lender: "compound-v3" | "morpho-blue", ref: MarketRef): AdapterPosition => ({
      lender, chainId: 8453, safe: SAFE, marketId: ref.marketId, collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 2, usd: 6000 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 3000, usd: 3000 }], health: 1.7, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 1n,
    });
    lenders.setPosition(COMPOUND, SAFE, pos("compound-v3", COMPOUND));
    const r = await whatIfFor({ ...ctx, db: w.db }, { asset: "ETH" });
    expect(r.loans.map((l) => l.venueId)).toEqual(["compound-v3"]);
    expect(r.loans[0].steps[0].hf).toBe(1.7);
    expect(r.loans[0].steps.find((s) => s.drop === 20)!.status).toBe("watch"); // 1.7 x 0.8 = 1.36: under 1.45, over 1.25
    expect(r.loans[0].steps.find((s) => s.drop === 25)!.status).toBe("watch"); // 1.275: still over 1.25
    expect(r.loans[0].steps.find((s) => s.drop === 30)!.status).toBe("risk"); // 1.19
  });

  it("with no loan: a hypothetical loan on the cheapest lender, with its liquidation price", async () => {
    const r = await whatIfFor({ ...ctx, db: w.db }, { cash: 5000, asset: "ETH" });
    expect(r.loans).toEqual([]);
    expect(r.hypothetical).toMatchObject({ cash: 5000, venueId: "morpho-blue" });
    expect(r.hypothetical!.liqPrice).toBeGreaterThan(0);
    expect(r.hypothetical!.steps[0].hf).toBeCloseTo(BALANCED_HF, 2);
  });
});

describe("Get cash (BP-34)", () => {
  it("chips never offer more than the Safe can borrow, across lenders", async () => {
    const g = await getCashFor(ctx, {});
    expect(g.state).toBe("ok");
    expect(g.chips.length).toBeGreaterThan(0);
    for (const c of g.chips) expect(c.amount).toBeLessThanOrEqual(g.maxCash);
    expect(g.chips.at(-1)!.amount).toBe(g.maxCash);
    // The best lender sets the maximum: Morpho's 86% threshold lends more than Aave's 83%.
    lenders.setMarket(MORPHO, { borrowable: false, notBorrowableReason: "off" });
    lenders.setMarket(COMPOUND, { borrowable: false, notBorrowableReason: "off" });
    const aaveOnly = await getCashFor(ctx, {});
    expect(aaveOnly.maxCash).toBeLessThan(g.maxCash);
  });

  it("an empty Safe says so, with no chips", async () => {
    w.services.fixture.setBalances(8453, MOCK_SAFE, {});
    const g = await getCashFor(ctx, {});
    expect(g).toMatchObject({ state: "empty", chips: [], maxCash: 0 });
  });

  it("screen 2: the three safety choices, what each locks, and the ranked lenders at one block", async () => {
    const g = await getCashFor(ctx, { cash: 5000, hfIdx: 1 });
    expect(g.levels.map((l) => l.title)).toEqual(["Extra safe", "Balanced", "Lean"]);
    expect(g.levels.every((l) => l.feasible)).toBe(true);
    expect(g.levels[0].collateral!).toBeGreaterThan(g.levels[2].collateral!);
    expect(g.lenders.map((l) => l.venueId)).toEqual(["morpho-blue", "compound-v3", "aave-v3"]);
    expect(g.best).toBe("morpho-blue");
    expect(g.asset).toBe("ETH");
  });

  it("a choice the Safe cannot fund says what it needs", async () => {
    const g = await getCashFor(ctx, { cash: 12_000, hfIdx: 2 });
    const extra = g.levels[0];
    expect(extra.feasible).toBe(false);
    expect(extra.needs!).toBeGreaterThan(g.balance);
  });
});
