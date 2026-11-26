// BP-20 on a Base fork: lower the oracle price, run the tick, get one alert in the thread (and one email); run it again, no second.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAbi, parseEther, parseUnits, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, oracleAbi, poolAbi, wethAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { createViemReader } from "@/server/chain/reader";
import { createTestDb } from "@/server/db/test-db";
import { alerts, messages, safeNetworks, safes, users } from "@/server/db/schema";
import { DevEmailProvider } from "@/server/email/provider";
import { runMonitorTick } from "@/server/monitor/tick";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe } from "../helpers/safe";
import { stubReturning } from "../helpers/oracle";

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


const oracleSource = parseAbi(["function getSourceOfAsset(address) view returns (address)"]);

describe("alert on a Base fork", () => {
  it("one alert when the oracle price falls below the At-risk level, none while it stays there", async () => {
    const db = await createTestDb();
    const [{ id: safeId }] = await db.insert(safes).values({ address: safe.toLowerCase(), name: "Fork Safe" }).returning();
    await db.insert(safeNetworks).values({ safeId, chainId: 8453, deployed: true, agentAdded: true });
    await db.insert(users).values({ address: privateKeyToAccount(ANVIL_KEYS[1]).address.toLowerCase(), email: "owner@example.com" });
    const reader = createViemReader();
    const email = new DevEmailProvider();
    const t0 = new Date("2026-01-01T00:00:00Z");
    const tick = (min: number) => runMonitorTick({ db, reader, now: new Date(t0.getTime() + min * 60_000), log: () => {}, email });

    await tick(0);
    expect(await db.select().from(alerts)).toHaveLength(0);
    const data = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [safe] });
    const hf0 = Number(data[5]) / 1e18;
    expect(hf0).toBeGreaterThan(1.6);

    // The price falls so that health is 1.2, below the default At-risk level of 1.35.
    const price = await fork.publicClient.readContract({ address: aave.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [WETH] });
    const source = await fork.publicClient.readContract({ address: aave.oracle, abi: oracleSource, functionName: "getSourceOfAsset", args: [WETH] });
    await stubReturning(fork, source, [(price * BigInt(Math.round((1.2 / hf0) * 1e6))) / 1_000_000n]);

    await tick(60);
    const [a] = await db.select().from(alerts);
    expect(a.hf).toBeLessThan(1.35);
    expect(a.cause).toMatch(/^ETH fell \d+% in 1h\.$/);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(email.sent.map((m) => m.to)).toEqual(["owner@example.com"]);

    await tick(120);
    expect(await db.select().from(alerts)).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });
});
