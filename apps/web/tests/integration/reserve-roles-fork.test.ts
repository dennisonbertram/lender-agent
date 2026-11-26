// R1-R9 and R12 (test-plan.md) on a Base fork with the real Roles v2 contracts, deployed and scoped by the
// Reserve Safe's owners exactly as in M0-6 (tests/helpers/reserve-setup.ts): the executor repays inside the
// allowance and every other call reverts on-chain.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther, parseUnits, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { allowanceNow, DevExecutorSigner, ROLE_KEY } from "@/server/reserve";
import { aaveRepayAbi, rolesAbi } from "@/server/reserve/roles-abi";
import { createViemReserveChain } from "@/server/reserve/executor/chain";
import { decodeRolesFailure } from "@/server/reserve/executor";
import { erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import type { ExecLink } from "@/server/reserve/types";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe } from "../helpers/safe";
import { EXECUTOR_KEY, USDC, deployReserve, executeRevoke, executorAddress } from "../helpers/reserve-setup";
import { setUsdc } from "../helpers/oracle";

const aave = AAVE[8453]!;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const chain = createViemReserveChain();
const signer = new DevExecutorSigner(EXECUTOR_KEY);
const stranger = privateKeyToAccount(ANVIL_KEYS[3]);

let fork: Fork;
let main: Address;
let link: ExecLink;
let snap: Hex;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function asMain(req: any) {
  const hash = await fork.walletClient.writeContract({ account: main, chain: fork.chain, gas: 2_000_000n, ...req });
  const r = await fork.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${req.functionName}`);
}
const debtOf = async () => (await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [main] }))[1];
const usdcOf = (a: Address) => fork.publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const left = async () => { const a = await chain.read(link); return allowanceNow(a.allowance, a.nowSec).left; };

/** The role call from `from`, simulated: returns null on success or the decoded Roles failure. */
async function viaRole(to: Address, data: Hex, o: { from?: Address; operation?: 0 | 1; value?: bigint; role?: Hex } = {}) {
  const wrapped = encodeFunctionData({ abi: rolesAbi, functionName: "execTransactionWithRole", args: [to, o.value ?? 0n, data, o.operation ?? 0, o.role ?? ROLE_KEY, true] });
  try { await fork.publicClient.call({ account: o.from ?? executorAddress, to: link.roles, data: wrapped }); return null; } catch (e) { return decodeRolesFailure(e); }
}
const repayData = (amount: bigint, o: { asset?: Address; mode?: bigint; onBehalfOf?: Address } = {}) =>
  encodeFunctionData({ abi: aaveRepayAbi, functionName: "repay", args: [o.asset ?? USDC, amount, o.mode ?? 2n, o.onBehalfOf ?? main] });

beforeAll(async () => {
  fork = await startBaseFork();
  setPublicClientForTests(8453, fork.publicClient as PublicClient);
  const owner = privateKeyToAccount(ANVIL_KEYS[1]).address as Address;
  main = (await deployTestSafe({ fork, owners: [owner], threshold: 1, saltNonce: "700" })).address;
  await fork.testClient.setBalance({ address: main, value: parseEther("20") });
  await fork.testClient.impersonateAccount({ address: main });
  await asMain({ address: WETH, abi: wethAbi, functionName: "deposit", value: parseEther("5") });
  await asMain({ address: WETH, abi: erc20Abi, functionName: "approve", args: [aave.pool, parseEther("5")] });
  await asMain({ address: aave.pool, abi: poolAbi, functionName: "supply", args: [WETH, parseEther("5"), main, 0] });
  await asMain({ address: aave.pool, abi: poolAbi, functionName: "borrow", args: [USDC, parseUnits("2000", 6), 2n, 0, main] });
  await setUsdc(fork, main, 0n);
  link = { ...(await deployReserve(fork, { mainSafe: main, dailyLimitUsdc: 1000, balanceUsdc: 10_000, saltNonce: "701" })), safeId: 1 };
  await fork.testClient.setBalance({ address: executorAddress, value: parseEther("10") });
  await fork.testClient.setBalance({ address: stranger.address, value: parseEther("10") });
}, 300_000);
afterAll(async () => { setPublicClientForTests(8453, undefined); await fork?.stop(); });
beforeEach(async () => { snap = (await fork.testClient.snapshot()) as unknown as Hex; });
afterEach(async () => { await fork.testClient.revert({ id: snap }); });

describe("Reserve role on a Base fork (R1-R9, R12)", () => {
  it("setup: the role has no approve permission and the owners' approval was signed once", async () => {
    expect(await viaRole(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [aave.pool, 1n] }))).toMatchObject({ name: "ConditionViolation", detail: "TargetAddressNotAllowed" });
    expect(await fork.publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [link.reserveSafe, aave.pool] })).toBeGreaterThan(0n);
  });

  it("R1: repays within the allowance on behalf of the main Safe; debt and allowance fall", async () => {
    const debt0 = await debtOf(); const bal0 = await usdcOf(link.reserveSafe);
    const r = await chain.repay(link, 600_000_000n, signer);
    expect(r.ok).toBe(true);
    expect(await left()).toBe(400_000_000n);
    expect(await usdcOf(link.reserveSafe)).toBe(bal0 - 600_000_000n);
    expect(Number(debt0 - (await debtOf())) / 1e8).toBeCloseTo(600, 0);
    expect((await chain.repay(link, 400_000_000n, signer)).ok).toBe(true);
    expect(await left()).toBe(0n);
  });

  it("R2: above the remaining allowance reverts, also uint256.max and one unit at zero", async () => {
    expect((await chain.repay(link, 600_000_000n, signer)).ok).toBe(true);
    const over = await chain.repay(link, 500_000_000n, signer);
    expect(over).toMatchObject({ ok: false, name: "ConditionViolation", detail: "AllowanceExceeded" });
    expect(await viaRole(USDC.length ? aave.pool : aave.pool, repayData(2n ** 256n - 1n))).toMatchObject({ detail: "AllowanceExceeded" });
    expect((await chain.repay(link, 400_000_000n, signer)).ok).toBe(true);
    expect(await chain.repay(link, 1n, signer)).toMatchObject({ ok: false, detail: "AllowanceExceeded" });
  });

  it("R3: on behalf of any other address, including the Reserve Safe, reverts", async () => {
    expect(await viaRole(aave.pool, repayData(1_000_000n, { onBehalfOf: "0x000000000000000000000000000000000000dEaD" }))).toMatchObject({ detail: "ParameterNotAllowed" });
    expect(await viaRole(aave.pool, repayData(1_000_000n, { onBehalfOf: link.reserveSafe }))).toMatchObject({ detail: "ParameterNotAllowed" });
  });

  it("R4: borrow, withdraw, supply and a repay with another asset or rate mode revert", async () => {
    const borrow = encodeFunctionData({ abi: poolAbi, functionName: "borrow", args: [USDC, 1n, 2n, 0, main] });
    const withdraw = encodeFunctionData({ abi: poolAbi, functionName: "withdraw", args: [WETH, 1n, executorAddress] });
    const supply = encodeFunctionData({ abi: poolAbi, functionName: "supply", args: [USDC, 1n, link.reserveSafe, 0] });
    for (const d of [borrow, withdraw, supply]) expect(await viaRole(aave.pool, d)).toMatchObject({ detail: "FunctionNotAllowed" });
    expect(await viaRole(aave.pool, repayData(1_000_000n, { mode: 1n }))).toMatchObject({ detail: "ParameterNotAllowed" });
    expect(await viaRole(aave.pool, repayData(1_000_000n, { asset: WETH }))).toMatchObject({ detail: "ParameterNotAllowed" });
  });

  it("R5: any other target (token transfer, approve, plain ETH) reverts", async () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [executorAddress, 1n] });
    expect(await viaRole(USDC, transfer)).toMatchObject({ detail: "TargetAddressNotAllowed" });
    expect(await viaRole(WETH, "0x", { value: 1n })).toMatchObject({ detail: "TargetAddressNotAllowed" });
    expect(await viaRole(executorAddress, "0x", { value: 1n })).toMatchObject({ detail: "TargetAddressNotAllowed" });
  });

  it("R6: a delegate call through the role reverts", async () => {
    expect(await viaRole(aave.pool, repayData(1_000_000n), { operation: 1 })).toMatchObject({ detail: "DelegateCallNotAllowed" });
  });

  it("R7: after the period the allowance refills to the limit and not above (lazy refill computed by the app)", async () => {
    expect((await chain.repay(link, 700_000_000n, signer)).ok).toBe(true);
    expect(await left()).toBe(300_000_000n);
    await fork.testClient.increaseTime({ seconds: 86_400 + 5 });
    await fork.testClient.mine({ blocks: 1 });
    expect(await left()).toBe(1_000_000_000n); // computed refill; the stored balance still reads 300
    expect((await chain.repay(link, 800_000_000n, signer)).ok).toBe(true);
    expect(await left()).toBe(200_000_000n);
    await fork.testClient.increaseTime({ seconds: 3 * 86_400 });
    await fork.testClient.mine({ blocks: 1 });
    expect(await left()).toBe(1_000_000_000n); // capped at the limit, not 200 + 3 days
  });

  it("R8: after the owners remove the member the executor call reverts with NoMembership", async () => {
    expect((await chain.read(link)).executorIsMember).toBe(true);
    await executeRevoke(fork, link);
    expect((await chain.read(link)).executorIsMember).toBe(false);
    expect(await chain.repay(link, 1_000_000n, signer)).toMatchObject({ ok: false, name: "NoMembership" });
  });

  it("R9: a key that is not the member reverts", async () => {
    expect(await viaRole(aave.pool, repayData(1_000_000n), { from: stranger.address })).toMatchObject({ name: "NotAuthorized" });
  });

  it("R12: asking for more than the debt takes only the debt; the allowance is charged the amount requested", async () => {
    // Pay the debt down to about 150 with the main Safe's own funds, then request 900 through the role.
    await setUsdc(fork, main, parseUnits("1850", 6));
    await asMain({ address: USDC, abi: erc20Abi, functionName: "approve", args: [aave.pool, 2n ** 255n] });
    await asMain({ address: aave.pool, abi: poolAbi, functionName: "repay", args: [USDC, parseUnits("1850", 6), 2n, main] });
    const debt = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [main] });
    const owed = Number(debt[1]) / 1e8;
    expect(owed).toBeLessThan(200);
    const bal0 = await usdcOf(link.reserveSafe);
    expect((await chain.repay(link, 900_000_000n, signer)).ok).toBe(true);
    expect(await debtOf()).toBe(0n);
    expect(Number(bal0 - (await usdcOf(link.reserveSafe))) / 1e6).toBeCloseTo(owed, 0);
    expect(await left()).toBe(100_000_000n);
    expect(await chain.repay(link, 1_000_000n, signer)).toMatchObject({ ok: false }); // nothing left to repay
  });
});
