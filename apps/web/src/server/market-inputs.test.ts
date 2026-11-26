import { describe, expect, it } from "vitest";
import { createFixtureReader } from "@/server/chain/fixture";
import { MOCK_EMPTY_SAFE, MOCK_SAFE } from "@/server/mock/seed";
import type { LoanPosition } from "@/shared/types";
import { tokenBySymbol } from "@/server/chain/config";
import { createFixtureLenders } from "@/server/lenders/fixture";
import type { LenderReads } from "@/server/lenders/reads";
import { liveInputs, maxCashFor } from "./market-inputs";

const safeInfo = (address: string) => ({ id: address, name: "Main Safe", address, threshold: "2 of 2", agent: true, networks: [{ id: "base" as const, deployed: true, agent: true }] });

const position = (over: Partial<LoanPosition>): LoanPosition => ({
  chainId: 8453, safe: MOCK_SAFE, lender: "aave-v3", id: `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`,
  collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
  debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n, ...over,
});

describe("liveInputs", () => {
  it("maps balances, prices and the Aave market to the library's inputs, with a block number", async () => {
    const reader = createFixtureReader();
    reader.setBalances(8453, MOCK_SAFE, { ETH: 2.5 });
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE);
    expect(inputs.blockNumber).toBeGreaterThan(0n);
    expect(inputs.balances.ETH).toBe(2.5);
    expect(inputs.venues[0]).toMatchObject({ id: "aave-v3", borrowAsset: "USDC", networks: ["base"] });
    expect(inputs.venues[0].markets.ETH).toEqual({ maxLtv: 0.8, lt: 0.83 });
    const max = maxCashFor(inputs, safeInfo(MOCK_SAFE));
    expect(max).toBeGreaterThan(500);
    expect(max).toBeLessThan(2.5 * 3000 * 0.8);
  });

  it("an empty Safe can borrow nothing", async () => {
    const reader = createFixtureReader();
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 0 });
    expect(maxCashFor(await liveInputs(reader, 8453, MOCK_EMPTY_SAFE), safeInfo(MOCK_EMPTY_SAFE))).toBe(0);
  });

  it("an existing single-pair Aave loan becomes a library Loan", async () => {
    const reader = createFixtureReader();
    reader.setPosition(8453, MOCK_SAFE, position({}));
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE);
    expect(inputs.unavailable).toBeNull();
    expect(inputs.loans).toEqual([expect.objectContaining({ venue: "Aave v3", collAsset: "ETH", collAmount: 1, debt: 1000, debtAsset: "USDC" })]);
  });

  it("an account holding another pair gets no Aave plan (D-05)", async () => {
    const reader = createFixtureReader();
    reader.setPosition(8453, MOCK_SAFE, position({ mixed: true }));
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE);
    expect(inputs.unavailable).toEqual({ venueId: "aave-v3", reason: "not available for this Safe yet" });
    expect(inputs.venues).toEqual([]);
  });

  it("keeps WETH apart from native ETH: only native ETH is planned with (the builder wraps native ETH only)", async () => {
    const reader = createFixtureReader();
    reader.setBalances(8453, MOCK_SAFE, { WETH: 2.5 } as never);
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE);
    expect(inputs.balances.ETH).toBe(0);
    expect(maxCashFor(inputs, safeInfo(MOCK_SAFE))).toBe(0);
    expect(inputs.weth).toBe(2.5);
  });

  it("subtracts the reserve's total debt (not this Safe's) from the borrow cap", async () => {
    const reader = createFixtureReader();
    const usdc = tokenBySymbol(8453, "USDC")!.address!;
    reader.setMarket(8453, { ...(await reader.readAaveMarket(8453, usdc)).market, borrowCap: 1_000_000, totalDebt: 990_000 });
    reader.setPosition(8453, MOCK_SAFE, position({}));
    const inputs = await liveInputs(reader, 8453, MOCK_SAFE);
    expect(inputs.liquidity.borrowCapLeft).toBe(10_000);
    expect(inputs.venues[0].liquidity).toBe(10_000);
  });
});

describe("liveInputs reads one block (BP-33)", () => {
  const recorded = () => {
    const reader = createFixtureReader();
    reader.setBalances(8453, MOCK_SAFE, { ETH: 2.5 });
    reader.mine(); // the chain is past the fixture's default block
    const calls: { read: string; blockNumber: bigint | undefined }[] = [];
    const r = reader as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const wrapped = { ...reader } as typeof reader;
    for (const name of ["readBalances", "readAavePosition", "readAaveMarket", "readPrices"] as const) {
      (wrapped as never as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        calls.push({ read: name, blockNumber: args[args.length - 1] as bigint | undefined });
        return r[name](...args);
      };
    }
    const lenders = createFixtureLenders();
    const lenderCalls: { read: string; blockNumber: bigint | undefined }[] = [];
    const reads: LenderReads = {
      market: async (ref, blockNumber) => { lenderCalls.push({ read: "market", blockNumber }); return lenders.market(ref, blockNumber); },
      position: async (ref, safe, blockNumber) => { lenderCalls.push({ read: "position", blockNumber }); return lenders.position(ref, safe, blockNumber); },
    };
    return { reader, wrapped, calls, reads, lenderCalls, lenders };
  };

  it("passes one block number to every market and position read, and stamps that block", async () => {
    const { reader, wrapped, calls, reads, lenderCalls } = recorded();
    const inputs = await liveInputs(wrapped, 8453, MOCK_SAFE, reads);
    const block = reader.state.blockNumber;
    expect(calls.length).toBeGreaterThan(3);
    expect(lenderCalls.some((c) => c.read === "market")).toBe(true);
    expect(lenderCalls.some((c) => c.read === "position")).toBe(true);
    for (const c of [...calls, ...lenderCalls]) expect(c.blockNumber, c.read).toBe(block);
    expect(inputs.blockNumber).toBe(block);
  });

  it("a lender that answers from another block is not mixed in", async () => {
    const { wrapped, reads, lenders } = recorded();
    const stray: LenderReads = { market: async (ref, b) => ({ ...(await reads.market(ref, b)), blockNumber: 1n }), position: lenders.position };
    const inputs = await liveInputs(wrapped, 8453, MOCK_SAFE, stray);
    const others = inputs.lenders.filter((l) => l.id !== "aave-v3");
    expect(others.length).toBeGreaterThan(0);
    for (const l of others) { expect(l.venue).toBeNull(); expect(l.note).toContain("could not be read"); }
  });

  it("an Aave read that ignores the block fails the whole read", async () => {
    const { reader, wrapped } = recorded();
    (wrapped as never as Record<string, unknown>).readPrices = async () => ({ prices: {}, chainId: 8453, blockNumber: reader.state.blockNumber + 5n, readAt: 0 });
    await expect(liveInputs(wrapped, 8453, MOCK_SAFE)).rejects.toThrow(/block/);
  });
});
