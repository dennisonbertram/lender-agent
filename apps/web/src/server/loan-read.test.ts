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
import { loanStandingOf } from "@/server/blocks/greeting";
import { readBlockData } from "@/server/blocks/block-inputs";
import { liveInputs, openLoansOf, unreadLenders } from "@/server/market-inputs";
import { loansNote } from "@/server/agent/context";
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


const aave = (over: Partial<LoanPosition> = {}): LoanPosition => ({
  chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
  collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
  debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n, ...over,
});
const morpho = (health: number): AdapterPosition => ({
  lender: "morpho-blue", chainId: 8453, safe: SAFE, marketId: MORPHO.marketId, collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 2, usd: 6000 }],
  debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }], health, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 1n,
});

describe("an unreadable lender is never \"no loan\" or \"healthy\" (P1)", () => {
  it("Aave healthy + Morpho unreadable: standing is unknown, names Morpho, status card says so", async () => {
    w.services.fixture.setPosition(8453, MOCK_SAFE, aave());
    lenders.fail("morpho-blue");
    const d = await readBlockData({ ...ctx, db: w.db });
    expect(unreadLenders(d.inputs)).toEqual(["Morpho"]);
    const st = await loanStandingOf(d, { db: w.db, safe: { id } as never });
    expect(st.status).not.toBe("healthy");
    expect((st as { unreadable?: string[] }).unreadable).toEqual(["Morpho"]);
    const s = await statusFor({ ...ctx, db: w.db });
    expect(s.sentence).toContain("Couldn't read Morpho just now");
    expect(s.sentence).not.toMatch(/fine|healthy/i);
    expect(s.loans).toHaveLength(1);
  });
  it("Morpho is the only loan and unreadable: no \"no open loan\"", async () => {
    lenders.fail("morpho-blue");
    const d = await readBlockData({ ...ctx, db: w.db });
    expect((await loanStandingOf(d, { db: w.db, safe: { id } as never })).status).toBe("unknown");
    expect((await statusFor({ ...ctx, db: w.db })).sentence).toContain("Couldn't read Morpho just now");
    expect(loansNote([], true, ["Morpho"])).not.toContain("App-verified");
    expect(loansNote([], false, ["Morpho"])).not.toContain("App-verified");
    expect(loansNote([], false, ["Morpho"])).toContain("Morpho");
  });
  it("a worse known loan keeps its status and still names the unread lender", async () => {
    w.services.fixture.setPosition(8453, MOCK_SAFE, aave({ healthFactor: 1.1 }));
    lenders.fail("compound-v3");
    const d = await readBlockData({ ...ctx, db: w.db });
    const st = await loanStandingOf(d, { db: w.db, safe: { id } as never });
    expect(st.status).toBe("risk");
    expect((st as { unreadable?: string[] }).unreadable).toEqual(["Compound v3"]);
  });
  it("all lenders read: no incomplete state, healthy still healthy", async () => {
    w.services.fixture.setPosition(8453, MOCK_SAFE, aave());
    const d = await readBlockData({ ...ctx, db: w.db });
    expect(unreadLenders(d.inputs)).toEqual([]);
    expect((await loanStandingOf(d, { db: w.db, safe: { id } as never })).status).toBe("healthy");
  });
});

describe("loan presence is outstanding debt on the raw positions (P2)", () => {
  it("mixed-collateral Aave debt is an open loan", async () => {
    w.services.fixture.setPosition(8453, MOCK_SAFE, aave({ mixed: true }));
    const i = await liveInputs(w.services.reader, 8453, SAFE, w.services.lenders);
    expect(i.loans).toHaveLength(0);
    expect(openLoansOf([i])).toMatchObject([{ venue: "Aave v3", debt: 1000 }]);
  });
  it("collateral only is not a loan", async () => {
    w.services.fixture.setPosition(8453, MOCK_SAFE, aave({ debt: [] }));
    lenders.setPosition(MORPHO, SAFE, { ...morpho(2), debt: [], health: null });
    const i = await liveInputs(w.services.reader, 8453, SAFE, w.services.lenders);
    expect(openLoansOf([i])).toEqual([]);
  });
  it("a Morpho loan counts", async () => {
    lenders.setPosition(MORPHO, SAFE, morpho(1.7));
    const i = await liveInputs(w.services.reader, 8453, SAFE, w.services.lenders);
    expect(openLoansOf([i])).toMatchObject([{ venue: "Morpho", debt: 1000 }]);
  });
});
