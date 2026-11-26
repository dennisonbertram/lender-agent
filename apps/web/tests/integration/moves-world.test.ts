// BP-36: the default moves deps can plan. With the served networks' chain reader and lenders (the fixture ones in MOCK), a Safe that
// holds its collateral on Arbitrum gets a move plan with a recorded LI.FI quote, and a plan block follows on any served network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { tokenBySymbol } from "@/server/chain/config";
import { createLifi } from "@/server/moves/lifi";
import { planBlockDraft, getMoveDeps, setMoveDepsForTests } from "@/server/moves/deps";
import quoteBody from "@/server/mock/moves-fixtures/quote-eth-base-to-ethereum.json";
import { MOCK_SAFE } from "@/server/mock/seed";
import { chainOf, MOVE_NETWORKS } from "@/server/moves/networks";
import { planCrossNetwork } from "@/server/moves/plan";
import { NATIVE } from "@/server/moves/types";
import { createTestWorld, type TestWorld } from "../helpers/world";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
let w: TestWorld;
beforeEach(async () => { setMoveDepsForTests(undefined); w = await createTestWorld(); });
afterEach(() => { setMoveDepsForTests(undefined); w.reset(); });

/** The recorded LI.FI quote, answered for whatever pair and amount is asked (the real client parses it). */
const recorded = (url: string) => {
  const q = new URL(url).searchParams;
  const body = structuredClone(quoteBody) as typeof quoteBody;
  const amount = q.get("fromAmount")!;
  Object.assign(body.action, { fromChainId: Number(q.get("fromChain")), toChainId: Number(q.get("toChain")), fromAddress: SAFE, toAddress: SAFE, fromAmount: amount });
  Object.assign(body.estimate, { fromAmount: amount, toAmount: ((BigInt(amount) * 996n) / 1000n).toString(), toAmountMin: ((BigInt(amount) * 995n) / 1000n).toString() });
  Object.assign(body.transactionRequest, { from: SAFE, chainId: Number(q.get("fromChain")), value: amount });
  return new Response(JSON.stringify(body));
};

describe("default move deps", () => {
  it("provide a world, and plan a move for collateral held on Arbitrum with a recorded quote", async () => {
    await w.trackSafe(MOCK_SAFE, { chainIds: [8453, 42161] });
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0, wstETH: 0, USDC: 0 });
    w.services.fixture.setBalances(42161, SAFE, { ETH: 5, wstETH: 0, USDC: 0 });
    // Aave on Arbitrum is paused, so the loan has to be made where a lender is open: Base.
    const usdc = tokenBySymbol(42161, "USDC")!.address!;
    const m = (await w.services.fixture.readAaveMarket(42161, usdc)).market;
    w.services.fixture.setMarket(42161, { ...m, isPaused: true });
    const deps = getMoveDeps(w.services);
    expect(deps.world).toBeTypeOf("function");
    const safeId = (await w.db.query.safes.findFirst())!.id;
    const world = await deps.world!({ db: w.db, services: w.services, safeId, safeAddress: SAFE }, { network: "arbitrum" });
    expect(world).not.toBeNull();
    expect(world!.safe.balances.arbitrum?.ETH).toBe(5);
    const aggregator = createLifi({ fetch: async (url) => recorded(url) });
    const plan = await planCrossNetwork({ aggregator, networks: MOVE_NETWORKS, chainOf }, { ...world!, safeAddress: SAFE, need: { cash: 3000, months: 12, targetHf: 1.6, asset: "ETH", network: "arbitrum" } });
    expect(plan?.quote).toBeTruthy();
    expect(plan!.quote!.fromChain).toBe(42161);
    expect(plan!.quote!.toChain).toBe(8453);
    expect(plan!.quote!.fromToken).toBe(NATIVE);
    expect(plan!.then?.network).toBe("base");
  });

  it("draft the loan plan block on Arbitrum arrivals as well as Base", async () => {
    const then = { kind: "open", venueId: "aave-v3", asset: "ETH", amount: 1, borrow: 1000, safeId: SAFE.toLowerCase() } as const;
    for (const network of ["base", "arbitrum"] as const) {
      const parts = await planBlockDraft({} as never, { then: { ...then, network }, arrivedUnits: 1, messageId: "m" });
      expect(parts).toHaveLength(1);
    }
    expect(await planBlockDraft({} as never, { then: { ...then, network: "ethereum" }, arrivedUnits: 1, messageId: "m" })).toEqual([]);
  });
});
