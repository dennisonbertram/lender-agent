// M4 exit criterion 2 (decision VC-02): the same loan shows the same rate, yearly cost, liquidation price,
// "can fall" and health on the plan card, the compare block, Get cash, the proposal card and the dashboard,
// all from the one quote function. One test per lender, on the fixture world (the fork twin is
// tests/integration/lenders-quote-fork.test.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { eq } from "drizzle-orm";
import { usd } from "@/lib/format";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { proposals } from "@/server/db/schema";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import { tokenBySymbol } from "@/server/chain/config";
import type { Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../tests/helpers/world";
import { COMET_USDC_BASE, MORPHO_WETH_USDC_ID } from "@/server/lenders/allowlist";
import type { FixtureLenders } from "@/server/lenders/fixture";
import type { MarketRef } from "@/server/lenders/types";
import { compareFor } from "@/server/blocks/compare";
import { getCashFor } from "@/server/blocks/get-cash";
import { whatIfFor } from "@/server/blocks/whatif";
import { loansFor } from "@/server/loans";
import { quotePlan } from "@/server/quote";
import { sendToSafe } from "@/server/proposals/send";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;
const REFS: Record<string, MarketRef> = {
  "compound-v3": { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" },
  "morpho-blue": { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC_ID, collateral: "WETH" },
};
const LT: Record<string, number> = { "aave-v3": 0.83, "compound-v3": 0.85, "morpho-blue": 0.86 };
const NAME: Record<string, string> = { "aave-v3": "Aave v3", "compound-v3": "Compound v3", "morpho-blue": "Morpho" };
const CASH = 5000;

let w: TestWorld;
let id: number;
let ctx: Awaited<ReturnType<typeof safeContext>>;
const qctx = () => ({ db: w.db, services: w.services, safe: { id, address: MOCK_SAFE.toLowerCase() } });

beforeEach(async () => {
  w = await createTestWorld();
  id = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  w.services.fixture.setBalances(8453, MOCK_SAFE, { ETH: 8 });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await w.services.fakes.get(8453)!.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => w.reset());

describe.each(["aave-v3", "compound-v3", "morpho-blue"])("one quote, every surface: %s", (venueId) => {
  it("rate, yearly cost, liquidation price, can fall and health agree on the plan, compare, Get cash, proposal and dashboard", async () => {
    // 1. The plan card.
    const q = await quotePlan(qctx(), { cash: CASH, venueId, asset: "ETH", messageId: "m1" });
    if (q.quote.kind !== "ok") throw new Error("expected ok");
    const plan = q.quote;
    const health = plan.price / plan.liqPrice;
    expect(plan.lender).toBe(NAME[venueId]);

    // 2. The compare block: one block number for the whole set.
    const cmp = await compareFor(ctx, { cash: CASH, asset: "ETH" });
    const row = cmp.rows.find((r) => r.venueId === venueId)!;
    expect(row).toMatchObject({ feasible: true, apr: plan.apr, yearly: plan.yearly, dropPct: plan.dropPct, liqPrice: plan.liqPrice, collateral: plan.collateral });
    expect(cmp.blockNumber).toBe(q.blockNumber);

    // 3. Get cash (screen 2's lenders and safety choices).
    const gc = await getCashFor(ctx, { cash: CASH, asset: "ETH", hfIdx: 1 });
    expect(gc.lenders.find((r) => r.venueId === venueId)).toEqual(row);
    expect(gc.blockNumber).toBe(q.blockNumber);

    // 4. What-if (the cheapest lender's hypothetical loan is that lender's plan).
    const wi = await whatIfFor({ ...ctx, db: w.db }, { cash: CASH, asset: "ETH" });
    if (wi.hypothetical!.venueId === venueId) {
      expect(wi.hypothetical!.liqPrice).toBe(plan.liqPrice);
      expect(wi.hypothetical!.steps[0].hf).toBeCloseTo(health, 9);
    }

    // 5. The proposal card, as stored by Send.
    const sent = await sendToSafe(ctx, { draftKey: q.draft.draftKey!, chainId: 8453, cash: CASH, venueId, asset: "ETH", hfIdx: 1 });
    expect(sent.stage).toBe("queued");
    const [prop] = await w.db.select().from(proposals).where(eq(proposals.id, sent.proposalId));
    expect(prop.outcome).toContain(`${usd(plan.yearly)} at ${plan.apr}%`);
    expect(prop.outcome).toContain(`The lender could sell some of your ETH if its price falls to about ${usd(plan.liqPrice)}`);
    expect(prop.outcome).toContain(`(${plan.dropPct}% below today's ${usd(plan.price)})`);
    expect((prop.testRun as { healthAfter: number }).healthAfter).toBeCloseTo(health, 9);

    // 6. The dashboard, once the loan exists: the lender's own health, worked out here from its own threshold.
    const price = 3000;
    const holding = { asset: "WETH", token: WETH, amount: plan.collateral, usd: plan.collateral * price };
    const debt = { asset: "USDC", token: USDC, amount: CASH, usd: CASH };
    const ownHealth = (plan.collateral * price * LT[venueId]) / CASH;
    if (venueId === "aave-v3") {
      w.services.fixture.setPosition(8453, MOCK_SAFE, {
        chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`, collateral: [holding], debt: [debt],
        healthFactor: ownHealth, liquidationThreshold: LT[venueId], ltv: 0.8, mixed: false, blockNumber: 57_172_000n,
      });
    } else {
      (w.services.lenders as FixtureLenders).setPosition(REFS[venueId], SAFE, {
        lender: venueId as "compound-v3", chainId: 8453, safe: SAFE, marketId: REFS[venueId].marketId, collateral: [holding], debt: [debt],
        health: ownHealth, liquidatable: false, liquidationThreshold: LT[venueId], mixed: false, blockNumber: 57_172_000n,
      });
    }
    const { loans } = await loansFor(ctx);
    const loan = loans.find((l) => l.lender === NAME[venueId])!;
    expect(loan).toBeTruthy();
    expect(loan.apr).toBe(plan.apr);
    expect(loan.yearlyInterest).toBe(plan.yearly);
    expect(loan.liquidationPrice).toBeCloseTo(plan.liqPrice, 9);
    expect(loan.healthFactor!).toBeCloseTo(health, 9);
    expect(loan.canFallPct).toContain(`${plan.dropPct}%`);
    expect(Math.round(loan.maxDrop * 100)).toBe(plan.dropPct);
  });
});
