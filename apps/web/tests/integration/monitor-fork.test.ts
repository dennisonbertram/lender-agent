// BP-18 on a Base fork: a monitor tick against a real Aave position stores a snapshot with the lender's own
// health, and lowering the oracle price shows in the next one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, parseUnits, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { createViemReader } from "@/server/chain/reader";
import { createTestDb } from "@/server/db/test-db";
import { safeNetworks, safes, snapshots } from "@/server/db/schema";
import { monitorStatusFor } from "@/server/monitor/status";
import { runMonitorTick } from "@/server/monitor/tick";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe } from "../helpers/safe";

const aave = AAVE[8453]!;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;

let fork: Fork;
let safe: Address;

async function retry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

/** A transaction sent as the Safe itself (impersonated): the same effect as Safe.execTransaction for this read test. Gas is explicit because estimating through the proxy under-shoots. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function asSafe(req: any) {
  const hash = await retry(() => fork.walletClient.writeContract({ account: safe, chain: fork.chain, gas: 2_000_000n, ...req }));
  const receipt = await fork.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${req.functionName}`);
}

beforeAll(async () => {
  fork = await startBaseFork();
  setPublicClientForTests(8453, fork.publicClient as PublicClient);
  const owner = privateKeyToAccount(ANVIL_KEYS[1]).address as Address;
  safe = (await deployTestSafe({ fork, owners: [owner], threshold: 1 })).address;
  await fork.testClient.setBalance({ address: safe, value: parseEther("20") });
  await fork.testClient.impersonateAccount({ address: safe });
  await asSafe({ address: WETH, abi: wethAbi, functionName: "deposit", value: parseEther("10") });
  await asSafe({ address: WETH, abi: erc20Abi, functionName: "approve", args: [aave.pool, parseEther("10")] });
  await asSafe({ address: aave.pool, abi: poolAbi, functionName: "supply", args: [WETH, parseEther("10"), safe, 0] });
  await asSafe({ address: aave.pool, abi: poolAbi, functionName: "borrow", args: [USDC, parseUnits("5000", 6), 2n, 0, safe] });
}, 240_000);

afterAll(async () => {
  setPublicClientForTests(8453, undefined);
  await fork?.stop();
});

describe("monitor tick on a Base fork", () => {
  it("writes a snapshot whose health is the lender's own value at the stored block, and a status the header can read", async () => {
    const db = await createTestDb();
    const [{ id: safeId }] = await db.insert(safes).values({ address: safe.toLowerCase(), name: "Fork Safe" }).returning();
    await db.insert(safeNetworks).values({ safeId, chainId: 8453, deployed: true, agentAdded: true });
    const reader = createViemReader();
    const t0 = new Date("2026-01-01T00:00:00Z");
    await runMonitorTick({ db, reader, now: t0, log: () => {} });
    const [snap] = await db.select().from(snapshots);
    expect(snap).toMatchObject({ safeId, chainId: 8453, loanId: `8453:${safe.toLowerCase()}:aave-v3` });
    const data = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [safe], blockNumber: snap.blockNumber });
    expect(Number(snap.health)).toBeCloseTo(Number(data[5]) / 1e18, 12);
    expect(Math.abs(Number(snap.debt) - 5000)).toBeLessThan(10);
    expect(Number(snap.price)).toBeGreaterThan(0);
    expect(await monitorStatusFor(db, safeId, [8453], new Date(t0.getTime() + 1000))).toMatchObject({ state: "watching", loans: 1, source: "Aave v3 on Base" });
  });
});
