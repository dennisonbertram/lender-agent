// Funded-network selection in Get cash (borrower review, finding 3): the planner picks an eligible
// funded source among the networks the wallet owns and the app serves, carries it in the response,
// and never silently reads or reports another network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import type { LoanPosition } from "@/shared/types";
import { delegateTypedData } from "@/server/safe/hash";
import { proposals, safes } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { liveInputs } from "@/server/market-inputs";
import { draftState, saveQuoteDraft } from "@/server/plan-drafts";
import { idempotencyKeyFor, sendToSafe } from "@/server/proposals/send";
import { planCheckFor } from "@/server/plan-check";
import { chatToolsFor } from "@/server/agent/tools";
import { safeContext } from "@/server/request";
import { createAccess } from "@/server/auth/access";
import { POST as QUOTE } from "@/app/api/safes/[address]/quote/route";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import type { Address, ChainId, Hex } from "@/shared/types";
import type { BlockCtx } from "./block-inputs";
import { greetingFor } from "./greeting";
import { compareFor } from "./compare";
import { getCashFor } from "./get-cash";
import { whatIfFor } from "./whatif";

let reader: FixtureReader;
const ctx = (address: string, owned: ChainId[], r: FixtureReader = reader): BlockCtx => ({
  services: { reader: r } as unknown as BlockCtx["services"],
  safe: { id: 1, address: address.toLowerCase(), name: "Main Safe" } as BlockCtx["safe"],
  networks: [],
  access: { ownedChainIds: owned } as BlockCtx["access"],
});

/** A reader whose reads fail on `broken` (an RPC outage on that network only). */
const withBroken = (r: FixtureReader, broken: ChainId[]): FixtureReader => ({
  ...r,
  readBlockNumber: (c: ChainId) => (broken.includes(c) ? Promise.reject(new Error("rpc down")) : r.readBlockNumber(c)),
});

beforeEach(() => {
  reader = createFixtureReader();
});

describe("get-cash picks the funded network the wallet owns", () => {
  it("an Arbitrum-only Safe plans on Arbitrum instead of failing the Base ownership check", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const g = await getCashFor(ctx(MOCK_SAFE, [42161]), {});
    expect(g.state).toBe("ok");
    expect(g.chainId).toBe(42161);
    expect(g.network).toBe("arbitrum");
    expect(g.networkName).toBe("Arbitrum");
    expect(g.maxCash).toBeGreaterThan(0);
    expect(g.holdings).toEqual([expect.objectContaining({ asset: "ETH", balance: 4 })]);
  });

  it("a two-network Safe funded only on Arbitrum plans on Arbitrum, not an empty Base", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const c = ctx(MOCK_SAFE, [8453, 42161]);
    const [g, greeting] = await Promise.all([getCashFor(c, {}), greetingFor(c)]);
    expect(g.state).toBe("ok");
    expect(g.chainId).toBe(42161);
    expect(g.network).toBe("arbitrum");
    expect(greeting.max).toBe(g.maxCash);
    expect(greeting.text).toContain("You can borrow up to");
    expect(greeting.text).not.toContain("is empty");
    expect(greeting.chips[0]).toMatch(/^Borrow \$/);
  });

  it("does not call a Safe empty when ownership of another tracked network is unknown", async () => {
    const c = { ...ctx(MOCK_SAFE, [8453]), access: { ownedChainIds: [8453], unreadChainIds: [42161] } } as BlockCtx;
    await expect(greetingFor(c)).rejects.toMatchObject({ status: 503 });
  });

  it("keeps a confirmed funded-network offer when ownership of another network is unreadable", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const c = { ...ctx(MOCK_SAFE, [42161]), access: { ownedChainIds: [42161], unreadChainIds: [8453] } } as BlockCtx;
    const [greeting, cash] = await Promise.all([greetingFor(c), getCashFor(c, {})]);
    expect(greeting.max).toBe(cash.maxCash);
    expect(greeting.max).toBeGreaterThan(0);
    expect(greeting.text).toContain("You can borrow up to");
  });

  it("a Safe funded on both keeps Base as the source and offers Arbitrum", async () => {
    reader.setBalances(8453, MOCK_SAFE, { ETH: 4 });
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161]), {});
    expect(g.chainId).toBe(8453);
    expect(g.network).toBe("base");
    expect(g.otherFunded).toEqual([
      expect.objectContaining({ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: expect.any(Number) }),
    ]);
  });

  it("an Arbitrum-only empty Safe names Arbitrum, not Base", async () => {
    const g = await getCashFor(ctx(MOCK_SAFE, [42161]), {});
    expect(g.state).toBe("empty");
    expect(g.chainId).toBe(42161);
    expect(g.networkName).toBe("Arbitrum");
  });

  it("a two-network Safe with nothing funded reports empty on Base", async () => {
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161]), {});
    expect(g.state).toBe("empty");
    expect(g.network).toBe("base");
    expect(g.otherFunded).toEqual([]);
  });

  it("the requested amount's safety choices and lenders come from the chosen network's read", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161]), { cash: 5000, hfIdx: 1 });
    expect(g.chainId).toBe(42161);
    expect(g.levels).toHaveLength(3);
    expect(g.levels.some((l) => l.feasible)).toBe(true);
    expect(g.lenders.length).toBeGreaterThan(0);
    expect(g.balance).toBe(4);
  });

  it("an amount above the Base maximum keeps Base but offers the Arbitrum source that can cover it", async () => {
    reader.setBalances(8453, MOCK_SAFE, { ETH: 1 });
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161]), { cash: 5000 });
    expect(g.network).toBe("base");
    expect(g.maxCash).toBeLessThan(5000);
    expect(g.otherFunded).toEqual([
      expect.objectContaining({ network: "arbitrum", maxCash: expect.any(Number) }),
    ]);
    expect(g.otherFunded[0].maxCash).toBeGreaterThanOrEqual(5000);
  });

  it("an explicit network selects that source even when another is funded", async () => {
    reader.setBalances(8453, MOCK_SAFE, { ETH: 4 });
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161]), { network: "arbitrum" });
    expect(g.chainId).toBe(42161);
    expect(g.balance).toBe(8);
  });

  it("a selected asset absent on the explicit network falls back to its funded default", async () => {
    reader.setBalances(8453, MOCK_SAFE, { wstETH: 4 });
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161]), { network: "arbitrum", asset: "wstETH", cash: 5000 });
    expect(g.network).toBe("arbitrum");
    expect(g.asset).toBe("ETH");
    expect(g.balance).toBe(8);
    expect(g.levels.some((level) => level.feasible)).toBe(true);
  });

  it("an explicit network the wallet does not own is refused", async () => {
    reader.setBalances(8453, MOCK_SAFE, { ETH: 4 });
    await expect(getCashFor(ctx(MOCK_SAFE, [8453]), { network: "arbitrum" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("get-cash: a network read that fails", () => {
  it("falls back to the funded network and marks the unread one", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161], withBroken(reader, [8453])), {});
    expect(g.chainId).toBe(42161);
    expect(g.unread).toEqual([expect.objectContaining({ network: "base", name: "Base" })]);
  });

  it("never reports an unread network's funds as empty without saying so", async () => {
    const g = await getCashFor(ctx(MOCK_SAFE, [8453, 42161], withBroken(reader, [8453])), {});
    expect(g.state).toBe("empty");
    expect(g.unread).toEqual([expect.objectContaining({ network: "base" })]);
  });

  it("when every owned network fails to read, the error reaches the caller", async () => {
    await expect(getCashFor(ctx(MOCK_SAFE, [8453, 42161], withBroken(reader, [8453, 42161])), {})).rejects.toThrow(/rpc down/);
  });

  it("keeps a verified owner on Arbitrum usable when the Base ownership read is unavailable", async () => {
    reader.setOwners(42161, MOCK_SAFE as Address, [MOCK_OWNER as Address]);
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const access = createAccess({ readOwners: async (chainId, safe) => {
      if (chainId === 8453) throw new Error("ownership RPC down");
      return reader.readSafeOwners(chainId, safe);
    } });
    const result = await access.safeAccess(MOCK_OWNER as Address, MOCK_SAFE as Address, [8453, 42161]);
    expect(result.ownedChainIds).toEqual([42161]);
    expect(result.unreadChainIds).toEqual([8453]);
    const g = await getCashFor({ ...ctx(MOCK_SAFE, result.ownedChainIds), access: result }, {});
    expect(g.network).toBe("arbitrum");
    expect(g.unread).toEqual([expect.objectContaining({ network: "base", name: "Base" })]);
  });
});

describe("the chosen source survives send and re-entry", () => {
  let w: TestWorld | undefined;
  afterEach(() => w?.reset());

  it("the draft's sent proposal is found on Arbitrum (not only on Base chains)", async () => {
    const db = await createTestDb();
    const [s] = await db.insert(safes).values({ address: MOCK_SAFE.toLowerCase(), name: "Main Safe" }).returning();
    const d = await saveQuoteDraft(db, s!.id, { text: "$5,000", hfIdx: 1, months: 12, network: "arbitrum", cash: 5000, messageId: "m1" });
    await db.insert(proposals).values({
      id: "p-arb", safeId: s!.id, chainId: 42161, spec: {}, idempotencyKey: idempotencyKeyFor(42161, MOCK_SAFE, d.draftKey!),
      title: "Borrow $5,000", steps: [], outcome: "", stage: "queued",
    });
    expect((await draftState(db, s!.id, "m1", [8453])).sentId).toBeUndefined();
    expect((await draftState(db, s!.id, "m1")).sentId).toBe("p-arb");
  });

  it("send refuses a Base proposal for a draft that was quoted on Arbitrum", async () => {
    w = await createTestWorld();
    const safeId = await w.trackSafe(MOCK_SAFE, { chainIds: [8453, 42161], agentAdded: true });
    w.services.fixture.setOwners(8453, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
    w.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
    w.services.fixture.setBalances(8453, MOCK_SAFE, { ETH: 8 });
    const { cookie } = await w.signIn(MOCK_OWNER);
    const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
    await w.services.fakes.get(8453)!.addDelegate({ safe: getAddress(MOCK_SAFE), delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
    const ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
    const d = await saveQuoteDraft(w.db, safeId, { text: "$5,000", hfIdx: 1, months: 12, network: "arbitrum", cash: 5000, messageId: "m1" });
    await expect(sendToSafe(ctx, { draftKey: d.draftKey!, chainId: 8453, cash: 5000 })).rejects.toMatchObject({ status: 422 });
  });
});

describe("the plan's other entry points agree on the funded network", () => {
  it("compare on an Arbitrum-only Safe ranks Arbitrum lenders instead of failing the ownership check", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const cmp = await compareFor(ctx(MOCK_SAFE, [42161]), { cash: 3000 });
    expect(cmp.network).toBe("Arbitrum");
    expect(cmp.source).toBe("arbitrum");
    expect(cmp.rows.some((r) => r.feasible)).toBe(true);
  });

  it("what-if on an Arbitrum-only Safe reads Arbitrum instead of failing the ownership check", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const w = await whatIfFor(ctx(MOCK_SAFE, [42161]), {});
    expect(w.cash).toBeGreaterThan(0);
    expect(w.hypothetical?.lender).toBeTruthy();
  });

  it("compare and what-if identify the unread owned chain when the other network is usable", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const partial = withBroken(reader, [8453]);
    const cmp = await compareFor(ctx(MOCK_SAFE, [8453, 42161], partial), { cash: 3000 });
    const whatIf = await whatIfFor(ctx(MOCK_SAFE, [8453, 42161], partial), {});
    expect(cmp.source).toBe("arbitrum");
    expect(cmp.unread).toEqual([expect.objectContaining({ network: "base", name: "Base" })]);
    expect(whatIf.chainId).toBe(42161);
    expect(whatIf.unread).toEqual([expect.objectContaining({ network: "base", name: "Base" })]);
  });

  it("what-if includes the Safe's existing Base loan even when Arbitrum is the funded plan source", async () => {
    reader.setPosition(8453, MOCK_SAFE, {
      chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
      collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
      healthFactor: 1.7, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n,
    } satisfies LoanPosition);
    reader.setPosition(42161, MOCK_SAFE, {
      chainId: 42161, safe: MOCK_SAFE, lender: "aave-v3", id: `42161:${MOCK_SAFE.toLowerCase()}:aave-v3`,
      collateral: [{ asset: "WETH", token: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", amount: 1, usd: 3000 }],
      debt: [{ asset: "USDC", token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amount: 1500, usd: 1500 }],
      healthFactor: 1.9, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n,
    } satisfies LoanPosition);
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const w = await whatIfFor(ctx(MOCK_SAFE, [8453, 42161]), {});
    expect(w.chainId).toBe(42161);
    expect(w.loans).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`, venueId: "aave-v3", network: "base", collAsset: "ETH" }),
      expect.objectContaining({ id: `42161:${MOCK_SAFE.toLowerCase()}:aave-v3`, venueId: "aave-v3", network: "arbitrum", collAsset: "ETH" }),
    ]));
    expect(w.loans).toHaveLength(2);
    expect(w.hypothetical).toBeNull();
  });

  it("the chat plan check resolves the funded served network and says which one it checked", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const read = (id: ChainId) => liveInputs(reader, id, MOCK_SAFE as Address);
    const check = planCheckFor(read, [await read(8453), await read(42161)], [8453, 42161]);
    expect(await check(10, {})).toMatchObject({ refusal: null, network: "arbitrum" });
    const block = await (chatToolsFor(check).planLoan.execute as (i: unknown, o: unknown) => Promise<unknown>)({ cash: 10 }, { toolCallId: "t", messages: [] });
    expect(block).toMatchObject({ kind: "plan", network: "arbitrum" });
  });

  it("a named network keeps the check (and its refusal) on that network", async () => {
    reader.setBalances(42161, MOCK_SAFE, { ETH: 4 });
    const read = (id: ChainId) => liveInputs(reader, id, MOCK_SAFE as Address);
    const check = planCheckFor(read, [await read(8453), await read(42161)], [8453, 42161]);
    expect(await check(10, { network: "base" })).toMatchObject({ refusal: { reason: "not_enough_collateral" }, network: "base" });
    expect(await check(10, { network: "arbitrum" })).toMatchObject({ refusal: null, network: "arbitrum" });
  });

  it("a quote that names no network lands on the funded owned network", async () => {
    const w = await createTestWorld();
    try {
      await w.trackSafe(MOCK_SAFE, { chainIds: [42161], agentAdded: true });
      w.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
      w.services.fixture.setBalances(42161, MOCK_SAFE, { ETH: 8 });
      const { cookie } = await w.signIn(MOCK_OWNER);
      const res = await QUOTE(w.req("/", { method: "POST", cookie, json: { cash: 5000 } }), { params: Promise.resolve({ address: MOCK_SAFE }) });
      expect(res.status).toBe(200);
      const q = await res.json();
      expect(q.chainId).toBe(42161);
      expect(q.network).toBe("arbitrum");
      expect(q.quote.network).toBe("Arbitrum");
    } finally {
      w.reset();
    }
  });

  it("a quote with only an explicit chainId keeps that selected funded chain", async () => {
    const w = await createTestWorld();
    try {
      await w.trackSafe(MOCK_SAFE, { chainIds: [8453, 42161], agentAdded: true });
      for (const chainId of [8453, 42161] as const) {
        w.services.fixture.setOwners(chainId, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
        w.services.fixture.setBalances(chainId, MOCK_SAFE, { ETH: 8 });
      }
      const { cookie } = await w.signIn(MOCK_OWNER);
      const res = await QUOTE(w.req("/", { method: "POST", cookie, json: { cash: 5000, chainId: 42161 } }), { params: Promise.resolve({ address: MOCK_SAFE }) });
      expect(res.status).toBe(200);
      const q = await res.json();
      expect(q.chainId).toBe(42161);
      expect(q.network).toBe("arbitrum");
      expect(q.quote.network).toBe("Arbitrum");
    } finally {
      w.reset();
    }
  });
});
