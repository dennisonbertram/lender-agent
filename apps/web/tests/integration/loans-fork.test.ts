// BP-17 on a Base fork: a real Aave position for a test Safe, read back through loansFor with the
// viem reader. The health shown is the lender's own getUserAccountData value at the stated block.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, parseUnits, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { createViemReader } from "@/server/chain/reader";
import { loansFor } from "@/server/loans";
import type { SafeContext } from "@/server/request";
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

const ctx = () => ({
  db: undefined, services: { reader: createViemReader() }, safe: { id: 1, address: safe.toLowerCase(), name: "Fork Safe" },
  networks: [{ safeId: 1, chainId: 8453, deployed: true, agentAdded: true }],
  access: { ownedChainIds: [8453], trackedChainIds: [8453], chat: true, ownersDiffer: false },
}) as unknown as SafeContext;

describe("loansFor on a Base fork", () => {
  it("shows the lender's own health factor at the stated block", async () => {
    const r = await loansFor(ctx());
    expect(r.loans).toHaveLength(1);
    const l = r.loans[0];
    expect(l.id).toBe(`8453:${safe.toLowerCase()}:aave-v3`);
    const data = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [safe], blockNumber: BigInt(l.blockNumber) });
    expect(l.healthFactor).toBeCloseTo(Number(data[5]) / 1e18, 12);
    expect(l.blockNumber).toBeGreaterThan(57_172_000);
    expect(l.mixed).toBe(false);
    expect(l.collateral[0]).toMatchObject({ asset: "ETH" });
    expect(l.collateral[0].amount).toBeCloseTo(10, 6);
    expect(l.debt.amount).toBeCloseTo(5000, 2);
    expect(l.status).toBe("healthy");
    expect(l.rowLine).toMatch(/^Borrowed \$(4,999|5,000) · ETH can fall \d+% before liquidation$/);
    expect(l.liquidationPrice).toBeGreaterThan(0);
    expect(r.watched).toBe(true);
    expect(r.balancesByNetwork[0].assets.map((a) => a.asset)).toContain("USDC");
  });
});
