// BP-12 on a Base fork: the quote's health equals the lender's own health after the batch is
// executed, and a Safe whose Aave account holds ETH collateral gets no wstETH plan there.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, parseEther, toHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { createViemReader } from "@/server/chain/reader";
import { setPublicClientForTests } from "@/server/chain/client";
import { tokenBySymbol } from "@/server/chain/config";
import { readAavePosition } from "@/server/chain/reads";
import { chainTestRunDeps, testRun } from "@/server/proposals/test-run";
import { quotePlan } from "@/server/quote";
import type { Address } from "@/shared/types";

const owner = privateKeyToAccount(ANVIL_KEYS[0]!).address as Address;
const WSTETH = tokenBySymbol(8453, "wstETH")!.address!;

async function startWithRetries(): Promise<Fork> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}

describe("quote on a Base fork", () => {
  let fork: Fork;
  let world: TestWorld;
  let salt = 700;
  beforeAll(async () => {
    fork = await startWithRetries();
    setPublicClientForTests(8453, fork.publicClient as PublicClient);
    world = await createTestWorld();
  });
  afterAll(async () => {
    setPublicClientForTests(8453, undefined);
    world?.reset();
    await fork?.stop();
  });

  async function newSafe(funds: { eth?: string; wsteth?: bigint }) {
    const d = await deployTestSafe({ fork, owners: [owner], threshold: 1, saltNonce: String(salt++) });
    if (funds.eth) await fork.testClient.setBalance({ address: d.address, value: parseEther(funds.eth) });
    if (funds.wsteth) {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [d.address, 1n]));
      await fork.testClient.setStorageAt({ address: WSTETH, index: slot, value: toHex(funds.wsteth, { size: 32 }) });
    }
    const id = await world.trackSafe(d.address, { name: `Safe ${salt}` });
    return { address: d.address, ctx: { db: world.db, services: { reader: createViemReader(), testRunDeps: chainTestRunDeps }, safe: { id, address: d.address.toLowerCase() } } };
  }
  const keys: Hex[] = [ANVIL_KEYS[0] as Hex];

  it("the quote's health equals the lender's own health after the batch is executed", async () => {
    const { address, ctx } = await newSafe({ eth: "10" });
    const q = await quotePlan(ctx, { cash: 5000, asset: "ETH", messageId: "m1" });
    expect(q.status).toBe("ok");
    if (q.quote.kind !== "ok") throw new Error("expected ok");
    expect(q.testRun.canSend).toBe(true);
    expect(q.blockNumber).toBeGreaterThan(57_000_000);
    const quotedHealth = q.quote.price / q.quote.liqPrice;

    const run = await testRun({
      chainId: 8453, safe: address, atRiskLevel: 1.35, healthBefore: null,
      spec: { kind: "open", venueId: "aave-v3", asset: "ETH", amount: q.quote.collateral, borrow: q.cash, safeId: "s", network: "base" },
    }, chainTestRunDeps);
    expect(run.ok).toBe(true);
    expect((await execSafeTx(fork, address, run.tx, keys)).success).toBe(true);
    const pos = (await readAavePosition(8453, address)).position!;
    expect(Math.abs(pos.healthFactor - quotedHealth) / pos.healthFactor).toBeLessThan(0.005);
    expect(pos.debt[0]!.amount).toBeCloseTo(q.cash, 2);

    // Now the loan exists: a second quote at the same lender and asset is for the full loan.
    const again = await quotePlan(ctx, { cash: 1000, asset: "ETH" });
    expect(again.status).toBe("ok");
    expect(again.costLine).toContain("on the full $6,000 loan");
  });

  it("a Safe with an ETH collateral loan on Aave gets no wstETH plan there", async () => {
    const { address, ctx } = await newSafe({ eth: "10", wsteth: parseEther("5") });
    const run = await testRun({
      chainId: 8453, safe: address, atRiskLevel: 1.35, healthBefore: null,
      spec: { kind: "open", venueId: "aave-v3", asset: "ETH", amount: 2, borrow: 1500, safeId: "s", network: "base" },
    }, chainTestRunDeps);
    expect((await execSafeTx(fork, address, run.tx, keys)).success).toBe(true);
    const r = await quotePlan(ctx, { cash: 1000, asset: "wstETH" });
    expect(r.status).toBe("unavailable");
    expect(r.quote).toEqual({ kind: "unavailable" });
    expect(r.testRun.reason).toBe("not available for this Safe yet");
  });
});
