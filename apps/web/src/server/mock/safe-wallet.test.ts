import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { buildOpen, buildOuterTx } from "@/server/aave/build";
import { proposals } from "@/server/db/schema";
import { safeTxHash } from "@/server/safe/hash";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "./seed";
import { otherRefs } from "@/server/lenders/reads";
import type { FixtureLenders } from "@/server/lenders/fixture";
import { mockConfirm, mockExecute } from "./safe-wallet";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";

describe("mock Safe{Wallet} (MOCK=1)", () => {
  let world: TestWorld;
  let tracked: Awaited<ReturnType<TestWorld["trackSafe"]>> | undefined;
  beforeEach(async () => { tracked = undefined; world = await createTestWorld(); });
  afterEach(() => world.reset());

  async function queueOpen(venueId = "aave-v3", n = 0) {
    tracked ??= await world.trackSafe(MOCK_SAFE);
    const safeId = tracked;
    const spec = { kind: "open" as const, venueId, asset: "ETH" as const, amount: 1, borrow: 1000, safeId: MOCK_SAFE, network: "base" as const };
    const tx = buildOuterTx(buildOpen({ chainId: 8453, safe: MOCK_SAFE, collateral: { asset: "ETH", amount: 1 }, borrow: { asset: "USDC", amount: 1000 } }).calls, BigInt(n));
    const hash = safeTxHash(8453, MOCK_SAFE, tx);
    const signature = await privateKeyToAccount(MOCK_OWNER_KEY).sign({ hash });
    await world.services.fakes.get(8453)!.proposeTransaction({ safe: MOCK_SAFE, tx, safeTxHash: hash, sender: MOCK_OWNER, signature });
    await world.db.insert(proposals).values({ id: `p${n + 1}`, safeId, chainId: 8453, spec, tx, nonce: BigInt(n), safeTxHash: hash, idempotencyKey: `k${n + 1}`, title: "Borrow", steps: [], outcome: "", stage: "queued" });
    return hash;
  }

  it("confirms, executes and applies the open to the fixture chain", async () => {
    const hash = await queueOpen();
    mockConfirm(world.services, 8453, hash, MOCK_OWNER);
    mockConfirm(world.services, 8453, hash, MOCK_COSIGNER);
    expect((await world.services.fakes.get(8453)!.getMultisigTransaction(hash))?.confirmations).toHaveLength(2);
    expect(await mockExecute(world.services, 8453, hash)).toMatchObject({ success: true });
    const tx = await world.services.fakes.get(8453)!.getMultisigTransaction(hash);
    expect(tx).toMatchObject({ isExecuted: true, isSuccessful: true });
    const { position } = await world.services.fixture.readAavePosition(8453, MOCK_SAFE);
    expect(position?.debt[0].amount).toBe(1000);
    expect(position?.healthFactor).toBeCloseTo((3000 * 0.83) / 1000, 6);
    const { balances } = await world.services.fixture.readBalances(8453, MOCK_SAFE);
    expect(balances.find((b) => b.symbol === "ETH")?.amount).toBeCloseTo(1.5);
    expect(balances.find((b) => b.symbol === "USDC")?.amount).toBe(1000);
    expect(await world.services.fixture.readSafeNonce(8453, MOCK_SAFE)).toBe(1n);
  });

  it("a second Morpho open adds to the position: debt, collateral and health follow", async () => {
    await mockExecute(world.services, 8453, await queueOpen("morpho-blue", 0));
    await mockExecute(world.services, 8453, await queueOpen("morpho-blue", 1));
    const ref = otherRefs(8453).find((r) => r.lender === "morpho-blue" && r.collateral === "WETH")!;
    const p = await world.services.lenders!.position(ref, MOCK_SAFE);
    expect(p?.debt[0].amount).toBe(2000);
    expect(p?.collateral[0].amount).toBe(2);
    expect(p?.health).toBeCloseTo((2 * 3000 * 0.86) / 2000, 6);
  });

  it("executing a Morpho plan opens the Morpho position and leaves Aave untouched", async () => {
    const hash = await queueOpen("morpho-blue");
    await mockExecute(world.services, 8453, hash);
    expect((await world.services.fixture.readAavePosition(8453, MOCK_SAFE)).position).toBeNull();
    const ref = otherRefs(8453).find((r) => r.lender === "morpho-blue" && r.collateral === "WETH")!;
    const p = await world.services.lenders!.position(ref, MOCK_SAFE);
    expect(p?.debt[0].amount).toBe(1000);
  });

  it("a reverted execution leaves the chain unchanged", async () => {
    const hash = await queueOpen();
    expect(await mockExecute(world.services, 8453, hash, { revert: true })).toMatchObject({ success: false });
    expect((await world.services.fixture.readAavePosition(8453, MOCK_SAFE)).position).toBeNull();
  });

  it("a reverted execution still uses the Safe nonce, as on a real chain", async () => {
    const hash = await queueOpen();
    const before = await world.services.fixture.readSafeNonce(8453, MOCK_SAFE);
    await mockExecute(world.services, 8453, hash, { revert: true });
    expect(await world.services.fixture.readSafeNonce(8453, MOCK_SAFE)).toBe(before! + 1n);
    const balances = (await world.services.fixture.readBalances(8453, MOCK_SAFE)).balances;
    expect(balances.find((b) => b.symbol === "ETH")?.amount).toBeCloseTo(2.5);
  });

  it("a stored Compound wstETH repayment updates the wstETH market position, not WETH", async () => {
    const hash = await queueOpen("compound-v3");
    const lenders = world.services.lenders as FixtureLenders;
    const wstRef = otherRefs(8453).find((r) => r.lender === "compound-v3" && r.collateral === "wstETH")!;
    const wethRef = otherRefs(8453).find((r) => r.lender === "compound-v3" && r.collateral === "WETH")!;
    const holding = (asset: string, amount: number) => ({ asset, token: `0x${"1".repeat(40)}` as `0x${string}`, amount, usd: amount * 1000 });
    const position = (collateral: "wstETH" | "WETH", debt: number) => ({
      lender: "compound-v3" as const, chainId: 8453 as const, safe: MOCK_SAFE, marketId: wstRef.marketId,
      collateral: [holding(collateral, 1)], debt: [holding("USDC", debt)], health: 3, liquidatable: false,
      liquidationThreshold: 0.85, mixed: false, blockNumber: world.services.fixture.state.blockNumber,
    });
    lenders.setPosition(wstRef, MOCK_SAFE, position("wstETH", 120));
    lenders.setPosition(wethRef, MOCK_SAFE, position("WETH", 400));
    world.services.fixture.setBalances(8453, MOCK_SAFE, { ETH: 0.1, USDC: 200 });
    const [row] = await world.db.select().from(proposals).where(eq(proposals.safeTxHash, hash));
    await world.db.update(proposals).set({ spec: {
      kind: "repay", loanId: `8453:${MOCK_SAFE.toLowerCase()}:compound-v3`, amount: 20,
      marketId: wstRef.marketId, collateral: "wstETH",
    } }).where(eq(proposals.id, row!.id));
    await mockExecute(world.services, 8453, hash);
    expect((await lenders.position(wstRef, MOCK_SAFE))?.debt[0]?.amount).toBe(100);
    expect((await lenders.position(wethRef, MOCK_SAFE))?.debt[0]?.amount).toBe(400);
    expect((await world.services.fixture.readBalances(8453, MOCK_SAFE)).balances.find((b) => b.symbol === "USDC")?.amount).toBe(180);
  });
});
