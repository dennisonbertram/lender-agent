import { beforeEach, describe, expect, it } from "vitest";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { proposals, safes, snapshots } from "@/server/db/schema";
import { createTestDb, type Db } from "@/server/db/test-db";
import type { SafeContext } from "@/server/request";
import type { Address, LoanPosition } from "@/shared/types";
import { createFixtureLenders, type FixtureLenders } from "@/server/lenders/fixture";
import { debtDisplay, loanDetail, loansFor } from "./loans";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const LOAN_ID = `8453:${SAFE.toLowerCase()}:aave-v3`;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const WSTETH = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

const position = (over: Partial<LoanPosition> = {}): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: LOAN_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }],
  debt: [{ asset: "USDC", token: USDC, amount: 2000, usd: 2000 }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_001n, ...over,
});

let db: Db;
let reader: FixtureReader;
let safeId: number;
const ctx = (agent: boolean, lenders?: FixtureLenders) => ({
  db, services: { reader, ...(lenders ? { lenders } : {}) }, safe: { id: safeId, address: SAFE.toLowerCase(), name: "Main" },
  networks: [{ safeId, chainId: 8453, deployed: true, agentAdded: agent }],
  access: { ownedChainIds: [8453], trackedChainIds: [8453], chat: true, ownersDiffer: false },
}) as unknown as SafeContext;

beforeEach(async () => {
  db = await createTestDb();
  reader = createFixtureReader();
  [{ id: safeId }] = await db.insert(safes).values({ address: SAFE.toLowerCase(), name: "Main" }).returning();
  reader.setBalances(8453, SAFE, { ETH: 1, USDC: 2000 });
});

describe("loansFor", () => {
  it("keeps mixed debt amount unknown when no token has a usable dollar price", () => {
    expect(debtDisplay([
      { asset: "WETH", token: WETH, amount: 1, usd: null },
      { asset: "USDC", token: USDC, amount: 1000, usd: null },
    ])).toEqual({ asset: "USD", amount: null, usd: null });
  });

  it("shows the status sentence, the row and the lender's health at a named block", async () => {
    reader.setPosition(8453, SAFE, position());
    const r = await loansFor(ctx(true));
    expect(r.sentence).toBe("Your loan is fine.");
    expect(r.watched).toBe(true);
    const [l] = r.loans;
    expect(l).toMatchObject({ id: LOAN_ID, lender: "Aave v3", status: "healthy", healthFactor: 2.49, blockNumber: 57_172_000, network: "base" });
    expect(l.rowLine).toBe("Borrowed $2,000 · ETH can fall 60% before liquidation");
    expect(l.canFallPct).toBe("ETH can fall 60% before liquidation");
    expect(l.liquidationPrice).toBeCloseTo(2000 / (2 * 0.83), 6);
    expect(l.limit.text).toBe("40% used · liquidated at 100%");
    expect(l.yearlyInterest).toBeCloseTo(2000 * l.apr! / 100, 6);
    expect(l.shell).toMatchObject({ hf: 2.49, status: "healthy", venue: "Aave v3" });
    expect(r.balancesByNetwork[0]).toMatchObject({ network: "base" });
    expect(r.balancesByNetwork[0].assets.map((a) => a.asset)).toEqual(["ETH", "USDC"]);
  });

  it("a debt-free position has no health factor (null survives JSON) and reads \"No debt\"", async () => {
    reader.setPosition(8453, SAFE, position({ debt: [], healthFactor: Number.POSITIVE_INFINITY }));
    const r = await loansFor(ctx(true));
    const wire = JSON.parse(JSON.stringify(r));
    expect(wire.loans[0].healthFactor).toBeNull();
    expect(wire.loans[0].shell.hf).toBeNull();
    expect(wire.loans[0].status).toBe("healthy");
    expect(wire.loans[0].rowLine).toBe("No debt");
  });

  it("never adds raw amounts of different debt assets: shows the dollar total", async () => {
    reader.setPosition(8453, SAFE, position({
      mixed: true,
      debt: [{ asset: "WETH", token: WETH, amount: 1, usd: 3000 }, { asset: "USDC", token: USDC, amount: 1000, usd: 1000 }],
    }));
    const [l] = (await loansFor(ctx(true))).loans;
    expect(l.debt).toEqual({ asset: "USD", amount: 4000, usd: 4000 });
  });

  it("keeps mixed loan and shell debt unknown instead of returning a made-up zero", async () => {
    reader.setPosition(8453, SAFE, position({
      mixed: true,
      healthFactor: 1.2,
      debt: [{ asset: "WETH", token: WETH, amount: 1, usd: null }, { asset: "USDC", token: USDC, amount: 1000, usd: null }],
    }));
    const [l] = (await loansFor(ctx(true))).loans;
    expect(l.debt).toEqual({ asset: "USD", amount: null, usd: null });
    expect(l.shell.debt).toBeNull();
    expect(l.rowLine).toContain("Debt value unavailable");
    expect(l.rowLine).not.toMatch(/Borrowed \$0|No debt/);
  });

  it("the shell loan (sidebar) uses the dashboard's debt label and amount for mixed debt", async () => {
    reader.setPosition(8453, SAFE, position({
      mixed: true,
      debt: [{ asset: "WETH", token: WETH, amount: 1, usd: 3000 }, { asset: "USDC", token: USDC, amount: 1000, usd: 1000 }],
    }));
    const [l] = (await loansFor(ctx(true))).loans;
    expect(l.shell.debtAsset).toBe(l.debt.asset);
    expect(l.shell.debt).toBe(l.debt.amount);
    expect(l.shell.debtAsset).toBe("USD");
  });

  it("a WETH-only Safe shows WETH in balances, valued at the ETH price", async () => {
    reader.setBalances(8453, SAFE, { WETH: 2 });
    const r = await loansFor(ctx(true));
    const [b] = r.balancesByNetwork;
    expect(b.assets).toHaveLength(1);
    expect(b.assets[0]).toMatchObject({ asset: "WETH", amount: 2 });
    expect(b.assets[0].usd).toBeGreaterThan(0);
    expect(b.totalUsd).toBe(b.assets[0].usd);
  });

  it("keeps a missing token price unknown instead of valuing that balance at zero", async () => {
    reader.setBalances(8453, SAFE, { ETH: 1, USDC: 100 });
    reader.setPrices({ ETH: 0 });
    const [b] = (await loansFor(ctx(true))).balancesByNetwork;
    expect(b.totalUsd).toBeNull();
    expect(b.assets.find((a) => a.asset === "ETH")?.usd).toBeNull();
    expect(b.assets.find((a) => a.asset === "USDC")?.usd).toBe(100);
  });

  it("marks assumed stablecoin pegs and unknown lender reads in the result", async () => {
    reader.setBalances(8453, SAFE, { USDC: 100 });
    reader.setPrices({ USDC: undefined } as unknown as Record<string, number>);
    const [funds] = (await loansFor(ctx(true))).balancesByNetwork;
    expect(funds.assets[0]).toMatchObject({ asset: "USDC", usd: 100, priceBasis: "assumed $1 peg" });

    reader.setPosition(8453, SAFE, position({ healthFactor: 2.4 }));
    const lenders = createFixtureLenders();
    lenders.fail("morpho-blue");
    const incomplete = await loansFor(ctx(true, lenders));
    expect(incomplete.loanReadsComplete).toBe(false);
    expect(incomplete.sentence).toMatch(/could not check every lending market/i);
    expect(incomplete.sentence).not.toMatch(/all .* loans? are fine|your loan is fine/i);
  });

  it("a mixed position hides the liquidation price but shows health and can fall", async () => {
    reader.setPosition(8453, SAFE, position({
      mixed: true, healthFactor: 1.4,
      collateral: [{ asset: "WETH", token: WETH, amount: 1, usd: 3000 }, { asset: "wstETH", token: WSTETH, amount: 1, usd: 3600 }],
    }));
    const [l] = (await loansFor(ctx(true))).loans;
    expect(l.mixed).toBe(true);
    expect(l.liquidationPrice).toBeNull();
    expect(l.healthFactor).toBe(1.4);
    expect(l.status).toBe("watch"); // between the default 1.25 and 1.45
    expect(l.rowLine).toBe("Borrowed $2,000 · Your collateral can fall 29% before liquidation");
  });

  it("says Not watched when no network has the agent, and still shows status", async () => {
    reader.setPosition(8453, SAFE, position({ healthFactor: 1.2 }));
    const r = await loansFor(ctx(false));
    expect(r.watched).toBe(false);
    expect(r.loans[0].status).toBe("risk");
    expect(r.sentence).toBe("1 loan needs action now.");
  });

  it("has no loans without an Aave position", async () => {
    const r = await loansFor(ctx(true));
    expect(r.loans).toEqual([]);
    expect(r.sentence).toBe("");
  });
});

describe("loanDetail", () => {
  const snap = (daysAgo: number, health: string) => ({
    safeId, chainId: 8453, loanId: LOAN_ID, at: new Date(Date.now() - daysAgo * 86_400_000), blockNumber: 1n, health, debt: "2000", collateral: "6000",
  });

  it("returns history from snapshots, oldest first, within 30 days", async () => {
    reader.setPosition(8453, SAFE, position());
    await db.insert(snapshots).values([snap(1, "2.2"), snap(10, "2.0"), snap(40, "1.1"), snap(5, "2.1")]);
    const d = await loanDetail(ctx(true), LOAN_ID);
    expect(d.history.map((p) => p.hf)).toEqual([2, 2.1, 2.2]);
    expect(d.history[0].day).toBeCloseTo(-10, 1);
    expect(d.openProposalIds).toEqual([]);
  });

  it("lists open proposals for this loan only", async () => {
    reader.setPosition(8453, SAFE, position());
    const row = (id: string, stage: string, loanId: string) => ({
      id, safeId, chainId: 8453, spec: { kind: "protect", loanId, addColl: 1, repay: 0 }, idempotencyKey: id, title: id, steps: [], outcome: "", stage,
    });
    await db.insert(proposals).values([row("a", "queued", LOAN_ID), row("b", "executed", LOAN_ID), row("c", "queued", "other"), row("d", "sending", LOAN_ID)]);
    expect((await loanDetail(ctx(true), LOAN_ID)).openProposalIds.sort()).toEqual(["a", "d"]);
  });

  it("lists the on-chain details: pool, token addresses (WETH kept) and the opening tx when stored", async () => {
    reader.setPosition(8453, SAFE, position());
    const hash = `0x${"ab".repeat(32)}`;
    const row = (id: string, spec: object, executedTxHash: string | null) => ({
      id, safeId, chainId: 8453, spec, idempotencyKey: id, title: id, steps: [], outcome: "", stage: "executed", executedTxHash,
    });
    await db.insert(proposals).values([row("o", { kind: "open", venueId: "aave-v3" }, hash), row("p", { kind: "open", venueId: "morpho-blue" }, `0x${"cd".repeat(32)}`)]);
    const d = await loanDetail(ctx(true), LOAN_ID);
    expect(d.loan.onchain.market).toEqual({ kind: "address", value: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" });
    expect(d.loan.onchain.collateral).toEqual([{ symbol: "WETH", address: WETH }]);
    expect(d.loan.onchain.debt).toEqual([{ symbol: "USDC", address: USDC }]);
    expect(d.openedTx).toBe(hash);
  });

  it("has no opening tx when none is stored", async () => {
    reader.setPosition(8453, SAFE, position());
    expect((await loanDetail(ctx(true), LOAN_ID)).openedTx).toBeNull();
  });

  it("404s for an unknown loan", async () => {
    await expect(loanDetail(ctx(true), "nope")).rejects.toMatchObject({ status: 404 });
  });
});
