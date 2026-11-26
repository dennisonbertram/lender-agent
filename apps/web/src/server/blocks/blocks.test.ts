import { ADD_FUNDS_TEXT } from "@/lib/add-funds-text";
import { beforeEach, describe, expect, it } from "vitest";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { MOCK_COSIGNER, MOCK_EMPTY_SAFE, MOCK_OWNER, MOCK_SAFE } from "@/server/mock/seed";
import type { LoanPosition } from "@/shared/types";
import type { BlockCtx } from "./block-inputs";
import { greetingFor } from "./greeting";
import { explainFor } from "./explain";
import { statusFor } from "./status";
import { holdingsFor } from "./holdings";
import { addFundsFor } from "./addfunds";
import { compareFor } from "./compare";
import { whatIfFor } from "./whatif";
import { getCashFor } from "./get-cash";
import { schema } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";

let reader: FixtureReader;
const ctx = (address: string, name = "Main Safe"): BlockCtx => ({
  services: { reader } as unknown as BlockCtx["services"],
  safe: { id: 1, address: address.toLowerCase(), name } as BlockCtx["safe"],
  networks: [],
  access: { ownedChainIds: [8453] } as BlockCtx["access"],
});
const position = (over: Partial<LoanPosition> = {}): LoanPosition => ({
  chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
  collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
  debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n, ...over,
});

beforeEach(() => {
  reader = createFixtureReader();
  reader.setOwners(8453, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  reader.setBalances(8453, MOCK_SAFE, { ETH: 2.5 });
  reader.setOwners(8453, MOCK_EMPTY_SAFE, [MOCK_OWNER], 1);
  reader.setBalances(8453, MOCK_EMPTY_SAFE, {});
});

describe("greeting", () => {
  it("empty Safe: empty text and two chips", async () => {
    const g = await greetingFor(ctx(MOCK_EMPTY_SAFE));
    expect(g.text).toContain("is empty");
    expect(g.text).not.toContain("co-signers");
    expect(g.chips).toEqual(["Add funds", "How does this work?"]);
    expect(g.blockNumber).toBeGreaterThan(0);
  });
  it("funded 2-of-2 Safe: live max, three chips, co-signers", async () => {
    const g = await greetingFor(ctx(MOCK_SAFE));
    expect(g.max).toBeGreaterThan(500);
    expect(g.text).toContain("co-signers");
    expect(g.chips).toHaveLength(3);
    expect(g.chips[0]).toMatch(/^Borrow \$/);
    expect(g.chips.slice(1)).toEqual(["How does this work?", "Compare lenders"]);
  });
  it("threshold 1 mentions no co-signers", async () => {
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 2 });
    const g = await greetingFor(ctx(MOCK_EMPTY_SAFE));
    expect(g.text).toContain("You can borrow up to");
    expect(g.text).not.toContain("co-signers");
  });
});

describe("greeting with a loan in trouble", () => {
  it.each([[1.2, "At risk"], [0.9, "liquidatable"]])("hf %s: no Borrow chip and no borrow sentence", async (hf) => {
    reader.setPosition(8453, MOCK_SAFE, position({ healthFactor: hf }));
    const g = await greetingFor(ctx(MOCK_SAFE));
    expect(g.chips).toEqual(["Fix my Aave v3 loan", "How does this work?"]);
    expect(g.text).toContain("One of your loans needs attention first.");
    expect(g.text).not.toMatch(/borrow up to/i);
  });
  it.each([[1.8], [1.5]])("hf %s (healthy / watch): the borrow chips stay", async (hf) => {
    reader.setPosition(8453, MOCK_SAFE, position({ healthFactor: hf }));
    const g = await greetingFor(ctx(MOCK_SAFE));
    expect(g.chips[0]).toMatch(/^Borrow \$/);
    expect(g.text).toContain("You can borrow up to");
  });
});

describe("whatif with no amount", () => {
  it("funded Safe: uses the Safe's own maximum (the greeting's), so there is a hypothetical", async () => {
    const g = await greetingFor(ctx(MOCK_SAFE));
    const w = await whatIfFor(ctx(MOCK_SAFE));
    expect(w.cash).toBe(g.max);
    expect(w.hypothetical).not.toBeNull();
  });
  it("every step carries the price after that fall, from the server", async () => {
    const w = await whatIfFor(ctx(MOCK_SAFE));
    const steps = w.hypothetical!.steps;
    expect(steps[0].price).toBe(Math.round(w.price));
    const s30 = steps.find((s) => s.drop === 30)!;
    expect(s30.price).toBe(Math.round(w.price * 0.7));
  });
  it("empty Safe: cash is 0 and there is no hypothetical", async () => {
    const w = await whatIfFor(ctx(MOCK_EMPTY_SAFE));
    expect(w.cash).toBe(0);
    expect(w.hypothetical).toBeNull();
  });
});

describe("status", () => {
  it("no loans: empty rows and sentence", async () => {
    const s = await statusFor(ctx(MOCK_SAFE));
    expect(s.loans).toEqual([]);
    expect(s.sentence).toBe("");
  });
  it("healthy vs at risk", async () => {
    reader.setPosition(8453, MOCK_SAFE, position({ healthFactor: 1.8 }));
    let s = await statusFor(ctx(MOCK_SAFE));
    expect(s.loans[0]).toMatchObject({ venue: "Aave v3", status: "healthy", hf: 1.8 });
    expect(s.sentence).toBe("Your loan is fine.");
    reader.setPosition(8453, MOCK_SAFE, position({ healthFactor: 1.2 }));
    s = await statusFor(ctx(MOCK_SAFE));
    expect(s.loans[0].status).toBe("risk");
    expect(s.sentence).toBe("1 loan needs action now.");
    reader.setPosition(8453, MOCK_SAFE, position({ healthFactor: 1.4 }));
    expect((await statusFor(ctx(MOCK_SAFE))).loans[0].status).toBe("watch");
    reader.setPosition(8453, MOCK_SAFE, position({ healthFactor: 0.9 }));
    expect((await statusFor(ctx(MOCK_SAFE))).loans[0].status).toBe("liquidatable");
  });
  it("uses the owner's saved levels, like the loan views (BP-19)", async () => {
    const db = await createTestDb();
    const [s] = await db.insert(schema.safes).values({ address: MOCK_SAFE.toLowerCase(), name: "Main Safe" }).returning();
    const id = `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`;
    await db.insert(schema.loanLevels).values({ safeId: s.id, loanId: id, chainId: 8453, warn: 3, act: 2 });
    reader.setPosition(8453, MOCK_SAFE, position({ healthFactor: 1.8 }));
    const c = { ...ctx(MOCK_SAFE), db, safe: { ...ctx(MOCK_SAFE).safe, id: s.id } } as BlockCtx;
    expect((await statusFor(c)).loans[0].status).toBe("risk");
    expect((await explainFor(c, "how")).levels).toEqual({ warn: 3, act: 2 });
  });
  it("mixed account shows health but flags no liquidation price", async () => {
    reader.setPosition(8453, MOCK_SAFE, position({ mixed: true, healthFactor: 1.7 }));
    const s = await statusFor(ctx(MOCK_SAFE));
    expect(s.loans).toHaveLength(1);
    expect(s.loans[0]).toMatchObject({ hf: 1.7, status: "healthy", mixed: true });
  });
});

describe("holdings", () => {
  it("rows with borrow-up-to per asset on Base", async () => {
    const h = await holdingsFor(ctx(MOCK_SAFE));
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ network: "base", asset: "ETH", amount: 2.5 });
    expect(h.rows[0].max).toBeGreaterThan(500);
    expect(h.blockNumber).toBeGreaterThan(0);
  });
  it("a WETH-only Safe lists WETH, with nothing to borrow against it", async () => {
    reader.setBalances(8453, MOCK_SAFE, { WETH: 2 });
    const h = await holdingsFor(ctx(MOCK_SAFE));
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ network: "base", asset: "WETH", amount: 2, max: 0 });
    expect(h.rows[0].value).toBeGreaterThan(0);
  });
  it("empty Safe has no rows", async () => {
    expect((await holdingsFor(ctx(MOCK_EMPTY_SAFE))).rows).toEqual([]);
  });
});

describe("addfunds", () => {
  it("address, Base, and the same wording as the panel", async () => {
    const a = await addFundsFor(ctx(MOCK_SAFE));
    expect(a.address).toBe(MOCK_SAFE);
    expect(a.networks).toEqual(["base"]);
    expect(a.text).toBe(ADD_FUNDS_TEXT);
    expect(a.text).toContain("Send ETH or wstETH to this address.");
    expect(a.text).not.toMatch(/USDC|DAI/);
  });
});

describe("explain", () => {
  it("liquidation names Aave's partial sale; other topics have none", async () => {
    reader.setPosition(8453, MOCK_SAFE, position());
    const e = await explainFor(ctx(MOCK_SAFE), "liquidation");
    expect(e.lenderLine).toContain("Aave v3 can sell only part");
    expect(e.needs).toBe(2);
    expect(e.maxCash).toBeGreaterThan(500);
    expect((await explainFor(ctx(MOCK_SAFE), "safe")).lenderLine).toBeNull();
  });
});

describe("G4: a network-scoped read needs ownership on that network", () => {
  const sepoliaOnly = (): BlockCtx => ({ ...ctx(MOCK_SAFE), access: { ownedChainIds: [84532] } as BlockCtx["access"] });
  it.each([
    ["compare", () => compareFor(sepoliaOnly(), { cash: 1000 })],
    ["whatif", () => whatIfFor(sepoliaOnly())],
    ["get-cash", () => getCashFor(sepoliaOnly(), {})],
  ])("%s is 403 for an owner on Base Sepolia only", async (_n, run) => {
    await expect(run()).rejects.toMatchObject({ status: 403 });
  });
});
