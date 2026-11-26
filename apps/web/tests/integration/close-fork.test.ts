// BP-26 on a Base fork: open a real Aave loan for a Safe, close it through `closeLoan` (the real
// reader, the real Test run), execute the stored transaction through Safe.execTransaction, and
// check the lender: zero debt and the collateral back in the Safe. Interest is let to accrue between
// the draft and the execution, so the repay margin is what makes the debt exactly zero.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, keccak256, parseEther, parseUnits, toHex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, poolAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { createViemReader } from "@/server/chain/reader";
import { readAavePosition } from "@/server/chain/reads";
import { proposals } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { closeLoan } from "@/server/proposals/close";
import { chainTestRunDeps, testRun } from "@/server/proposals/test-run";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import type { Address, Hex, SafeTx } from "@/shared/types";
import type { Spec } from "@/lib/proposals";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { createTestWorld, type TestWorld } from "../helpers/world";

const owner = privateKeyToAccount(ANVIL_KEYS[1]).address as Address;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const WSTETH = tokenBySymbol(8453, "wstETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;
const pool = AAVE[8453]!.pool;

let fork: Fork;
let w: TestWorld;
let salt = 700;

beforeAll(async () => {
  let last: unknown;
  for (let i = 0; i < 3 && !fork; i++) {
    try { fork = await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  if (!fork) throw last;
  setPublicClientForTests(8453, fork.publicClient as PublicClient);
}, 240_000);
afterAll(async () => {
  setPublicClientForTests(8453, undefined);
  await fork?.stop();
});
beforeEach(async () => { w = await createTestWorld(); });
afterEach(() => w.reset());

const balance = (token: Address, who: Address) => fork.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
async function setErc20(token: Address, who: Address, slot: bigint, value: bigint) {
  const index = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, slot]));
  await fork.testClient.setStorageAt({ address: token, index, value: toHex(value, { size: 32 }) });
}
const days = async (n: number) => { await fork.testClient.increaseTime({ seconds: n * 86_400 }); await fork.testClient.mine({ blocks: 1 }); };

/** A Safe with an open loan of `coll` and `borrow` USDC, wired into the app's mock world with the real chain reader. */
async function openLoan(coll: "ETH" | "wstETH", amount: number, borrow: number) {
  const d = await deployTestSafe({ fork, owners: [owner], threshold: 1, saltNonce: String(salt++) });
  const safe = d.address;
  if (coll === "ETH") await fork.testClient.setBalance({ address: safe, value: parseEther("10") });
  else await setErc20(WSTETH, safe, 1n, parseEther("5"));
  const spec: Spec = { kind: "open", venueId: "aave", asset: coll, amount, borrow, safeId: "s", network: "base" };
  const r = await testRun({ chainId: 8453, safe, spec, healthBefore: null, atRiskLevel: 1.35 });
  expect(r.canSend).toBe(true);
  expect((await execSafeTx(fork, safe, r.tx, [ANVIL_KEYS[1]])).success).toBe(true);
  // Cover the interest that will accrue: the Safe holds the borrowed USDC plus a little extra.
  await setErc20(USDC, safe, 9n, parseUnits(String(borrow + 25), 6));

  const safeId = await w.trackSafe(safe, { agentAdded: true });
  w.services.fixture.setOwners(8453, safe, [MOCK_OWNER], 1);
  w.services.fakes.get(8453)!.setOwners(safe, [MOCK_OWNER], 1);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await w.services.fakes.get(8453)!.addDelegate({ safe, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
  w.services.reader = createViemReader();
  w.services.testRunDeps = chainTestRunDeps;
  const { cookie } = await w.signIn(MOCK_OWNER);
  const ctx = await safeContext(w.req("/", { cookie }), safe, w.services);
  return { safe, safeId, ctx };
}

describe("close a loan on a Base fork", () => {
  it("ETH loan: repays all debt (interest accrued after the draft included) and returns all the collateral to the Safe", async () => {
    const { safe, ctx } = await openLoan("ETH", 2, 1500);
    await days(30);
    const before = (await readAavePosition(8453, safe)).position!;
    expect(before.debt[0]!.amount).toBeGreaterThan(1500);

    const r = await closeLoan(ctx, { loanId: `8453:${safe.toLowerCase()}:aave-v3` });
    expect(r.stage).toBe("queued");
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(row!.outcome).toMatch(/pay back 1,5\d\d(\.\d+)? USDC/);

    await days(2); // interest keeps running between the draft and the execution
    const exec = await execSafeTx(fork, safe, row!.tx as SafeTx, [ANVIL_KEYS[1]]);
    expect(exec.success).toBe(true);

    const after = (await readAavePosition(8453, safe)).position;
    expect(after).toBeNull(); // no debt and no collateral left in the lender: the loan is gone
    expect(await balance(WETH, safe)).toBeGreaterThanOrEqual(parseEther("2"));
    const usdcLeft = Number(await balance(USDC, safe)) / 1e6;
    expect(usdcLeft).toBeGreaterThan(0); // only the debt left the Safe, not the whole balance
    expect(usdcLeft).toBeLessThan(40);
    const approved = await fork.publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [safe, pool] });
    expect(approved).toBeLessThan(1_000_000n); // the margin is not left behind as an open approval
  }, 240_000);

  it("a loan aged 30 days, then 7 days of signing delay: no debt is left and all the collateral is back", async () => {
    const { safe, ctx } = await openLoan("ETH", 2, 1500);
    await days(30);
    const r = await closeLoan(ctx, { loanId: `8453:${safe.toLowerCase()}:aave-v3` });
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    await days(7); // the maximum signing delay the approval is sized for; the old 0.1% margin would not cover it
    expect((await execSafeTx(fork, safe, row!.tx as SafeTx, [ANVIL_KEYS[1]])).success).toBe(true);
    expect((await readAavePosition(8453, safe)).position).toBeNull();
    expect(await balance(WETH, safe)).toBeGreaterThanOrEqual(parseEther("2"));
  }, 240_000);

  it("wstETH loan closes the same way", async () => {
    const { safe, ctx } = await openLoan("wstETH", 1, 1000);
    await days(10);
    const r = await closeLoan(ctx, { loanId: `8453:${safe.toLowerCase()}:aave-v3` });
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect((await execSafeTx(fork, safe, row!.tx as SafeTx, [ANVIL_KEYS[1]])).success).toBe(true);
    expect((await readAavePosition(8453, safe)).position).toBeNull();
    expect(await balance(WSTETH, safe)).toBeGreaterThanOrEqual(parseEther("5")); // all of it, as before the loan
  }, 240_000);

  it("not enough USDC: says how much is missing and drafts nothing", async () => {
    const { safe, ctx } = await openLoan("ETH", 2, 1500);
    await setErc20(USDC, safe, 9n, parseUnits("1000", 6));
    const err = await closeLoan(ctx, { loanId: `8453:${safe.toLowerCase()}:aave-v3` }).catch((e) => e);
    expect(err.line).toMatch(/Add \$5\d\d(\.\d\d)? more USDC/);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  }, 240_000);
});
