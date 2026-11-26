// Contract tests R1-R9 and R12 (test-plan.md) on a Base fork with the real Roles v2 mastercopy, the real
// ModuleProxyFactory and the real Aave v3 Pool. The setup batch is the one `buildReserveSetup` builds,
// executed by the Reserve Safe's owners only (2 of 2, anvil keys). The executor is a DevExecutorSigner
// (anvil key 2); the attacker is key 4. No hosted Zodiac API is called.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeErrorResult, encodeAbiParameters, encodeFunctionData, keccak256, parseUnits, toHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE } from "@/server/chain/config";
import { allowanceNow, ALLOWANCE_KEY, buildReserveSetup, buildRoleRepay, DevExecutorSigner, MODULE_PROXY_FACTORY, RESERVE_ASSET, ROLE_KEY, ROLES_V2_MASTERCOPY, sendRoleCall } from "@/server/reserve";
import { readReserveChain } from "@/server/reserve/read";
import { aaveRepayAbi, rolesAbi, safeModuleAbi } from "@/server/reserve/roles-abi";
import { testRun } from "@/server/proposals/test-run";
import type { Spec } from "@/lib/proposals";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";

const { pool: POOL, usdc: USDC } = RESERVE_ASSET[8453]!;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const acct = (i: number) => privateKeyToAccount(ANVIL_KEYS[i]);
const executorSigner = new DevExecutorSigner(ANVIL_KEYS[2]);
const attacker = new DevExecutorSigner(ANVIL_KEYS[4]);
const LIMIT = parseUnits("1000", 6);

let fork: Fork;
let client: PublicClient;
let reserve: Address;
let main: Address;
let roles: Address;
let snap: Hex;
let fromBlock: bigint; // the block at link time: logs are read from here (the fork's older blocks are upstream)

const bal = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
async function setUsdc(who: Address, value: bigint) {
  const index = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
  await fork.testClient.setStorageAt({ address: USDC, index, value: toHex(value, { size: 32 }) });
}
const debtOf = async () => {
  const dp = AAVE[8453]!.dataProvider as Address;
  const r = await client.readContract({ address: dp, abi: [{ type: "function", name: "getUserReserveData", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint40" }, { type: "bool" }] }], functionName: "getUserReserveData", args: [USDC, main] }) as readonly bigint[];
  return r[2]!;
};
const allowanceLeft = async () => {
  const [refill, maxRefill, period, balance, timestamp] = await client.readContract({ address: roles, abi: rolesAbi, functionName: "allowances", args: [ALLOWANCE_KEY] });
  const block = await client.getBlock();
  return allowanceNow({ refill, maxRefill, period, balance, timestamp }, Number(block.timestamp)).left;
};
/** Dry-run (eth_call) then decode the Roles error; returns its name or "ok". */
async function dryRun(signer: DevExecutorSigner, to: Address, data: Hex, opts: { operation?: 0 | 1; roleKey?: Hex; target?: Address; value?: bigint } = {}) {
  const call = encodeFunctionData({ abi: rolesAbi, functionName: "execTransactionWithRole", args: [to, opts.value ?? 0n, data, opts.operation ?? 0, opts.roleKey ?? ROLE_KEY, true] });
  try {
    await client.call({ account: signer.address, to: roles, data: call });
    return "ok";
  } catch (e: any) {
    const raw = findData(e);
    if (!raw) return `unknown: ${e.shortMessage ?? e.message}`;
    const err = decodeErrorResult({ abi: rolesAbi, data: raw });
    return err.errorName === "ConditionViolation" ? `ConditionViolation:${STATUS_NAME[Number(err.args![0])] ?? err.args![0]}` : err.errorName;
  }
}
function findData(e: any): Hex | undefined {
  for (let c = e; c; c = c.cause) if (typeof c.data === "string" && c.data.startsWith("0x")) return c.data;
  return undefined;
}
const repayData = (amount: bigint, o: { asset?: Address; rate?: bigint; onBehalfOf?: Address } = {}) =>
  encodeFunctionData({ abi: aaveRepayAbi, functionName: "repay", args: [o.asset ?? USDC, amount, o.rate ?? 2n, o.onBehalfOf ?? main] });
const roleRepay = (amount: bigint) => sendRoleCall(client, executorSigner, buildRoleRepay({ chainId: 8453, roles, mainSafe: main, amount }));
// Roles v2 `Status` enum (the part we meet).
const STATUS_NAME: Record<number, string> = { 1: "DelegateCallNotAllowed", 2: "TargetAddressNotAllowed", 3: "FunctionNotAllowed", 4: "SendNotAllowed", 7: "ParameterNotAllowed", 17: "AllowanceExceeded" };

beforeAll(async () => {
  let last: unknown;
  for (let i = 0; i < 3 && !fork; i++) {
    try { fork = await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  if (!fork) throw last;
  client = fork.publicClient as PublicClient;
  setPublicClientForTests(8453, client);

  // The Roles v2 mastercopy and the ModuleProxyFactory exist on Base.
  for (const a of [ROLES_V2_MASTERCOPY, MODULE_PROXY_FACTORY]) expect((await client.getCode({ address: a }))!.length).toBeGreaterThan(4000);

  // Main Safe with a real Aave v3 USDC debt.
  const m = await deployTestSafe({ fork, owners: [acct(3).address], threshold: 1, saltNonce: "9100" });
  main = m.address;
  await fork.testClient.setBalance({ address: main, value: parseUnits("10", 18) });
  const spec: Spec = { kind: "open", venueId: "aave", asset: "ETH", amount: 3, borrow: 2000, safeId: "s", network: "base" };
  const open = await testRun({ chainId: 8453, safe: main, spec, healthBefore: null, atRiskLevel: 1.35 });
  expect(open.canSend).toBe(true);
  expect((await execSafeTx(fork, main, open.tx, [ANVIL_KEYS[3]])).success).toBe(true);
  await setUsdc(main, 0n); // the main Safe spent the cash; only the Reserve can repay

  // Reserve Safe, 2 of 2 owners, 10,000 USDC, signs the setup batch built by buildReserveSetup.
  const r = await deployTestSafe({ fork, owners: [acct(0).address, acct(1).address], threshold: 2, saltNonce: "9101" });
  reserve = r.address;
  await setUsdc(reserve, parseUnits("10000", 6));
  await fork.testClient.setBalance({ address: executorSigner.address, value: parseUnits("1", 18) });
  await fork.testClient.setBalance({ address: attacker.address, value: parseUnits("1", 18) });
  const block = await client.getBlock();
  fromBlock = block.number;
  const setup = buildReserveSetup({ chainId: 8453, reserveSafe: reserve, mainSafe: main, executor: executorSigner.address, dailyLimit: LIMIT, nowSec: Number(block.timestamp) }, 0);
  roles = setup.roles;
  const done = await execSafeTx(fork, reserve, setup.tx, [ANVIL_KEYS[0], ANVIL_KEYS[1]]);
  expect(done.success).toBe(true);
  snap = await fork.testClient.snapshot();
}, 300_000);
afterAll(async () => { setPublicClientForTests(8453, undefined); await fork?.stop(); });
beforeEach(async () => {
  await fork.testClient.revert({ id: snap });
  snap = await fork.testClient.snapshot();
});

describe("setup batch (owner-signed only)", () => {
  it("deploys the modifier at the predicted address, enables it, scopes it and reads back from chain", async () => {
    expect((await client.getCode({ address: roles }))!.length).toBeGreaterThan(10);
    expect(await client.readContract({ address: reserve, abi: safeModuleAbi, functionName: "isModuleEnabled", args: [roles] })).toBe(true);
    const chain = (await readReserveChain(client, { chainId: 8453, reserve, roles, mainSafe: main, executor: executorSigner.address, fromBlock }))!;
    expect(chain.issues).toEqual([]);
    expect(chain.executorIsMember).toBe(true);
    expect(chain.allowance.maxRefill).toBe(LIMIT);
    expect(chain.allowance.period).toBe(86_400n);
    expect(chain.approval).toBeGreaterThan(0n);
  });
  it("owners calling the role directly from an EOA is refused (only the Safe is owner)", async () => {
    const data = encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [attacker.address, [ROLE_KEY], [true]] });
    await expect(fork.walletClient.sendTransaction({ account: acct(0), chain: fork.chain, to: roles, data })).rejects.toThrow();
  });
  it("one of two owner signatures is not enough", async () => {
    const setup = buildReserveSetup({ chainId: 8453, reserveSafe: reserve, mainSafe: main, executor: attacker.address, dailyLimit: LIMIT, nowSec: 1 }, 1);
    const r = await execSafeTx(fork, reserve, setup.tx, [ANVIL_KEYS[0]]);
    expect(r.receipt.status).toBe("reverted"); // GS020: signatures too short
    expect(await client.getCode({ address: setup.roles })).toBeUndefined();
  });
});

describe("contract tests R1-R9, R12", () => {
  it("R1: executor repays within the allowance for the main Safe; debt and allowance fall by the amount", async () => {
    const debt0 = await debtOf();
    const rb0 = await bal(USDC, reserve);
    const left0 = await allowanceLeft();
    expect(left0).toBe(LIMIT);
    const r = await roleRepay(parseUnits("600", 6));
    expect(r.status).toBe("success");
    expect(debt0 - (await debtOf())).toBeGreaterThanOrEqual(parseUnits("599.9", 6));
    expect(rb0 - (await bal(USDC, reserve))).toBe(parseUnits("600", 6));
    expect(await allowanceLeft()).toBe(parseUnits("400", 6));
    expect((await roleRepay(parseUnits("400", 6))).status).toBe("success");
    expect(await allowanceLeft()).toBe(0n);
  });
  it("R2: repay above the remaining allowance, max uint, or with none left, reverts", async () => {
    await roleRepay(parseUnits("600", 6));
    expect(await dryRun(executorSigner, POOL, repayData(parseUnits("500", 6)))).toBe("ConditionViolation:AllowanceExceeded");
    expect(await dryRun(executorSigner, POOL, repayData(2n ** 256n - 1n))).toBe("ConditionViolation:AllowanceExceeded");
    await roleRepay(parseUnits("400", 6));
    expect(await dryRun(executorSigner, POOL, repayData(1n))).toBe("ConditionViolation:AllowanceExceeded");
  });
  it("R3: repay on behalf of any other address, or of the Reserve Safe itself, reverts", async () => {
    expect(await dryRun(executorSigner, POOL, repayData(1n, { onBehalfOf: attacker.address }))).toMatch(/^ConditionViolation/);
    expect(await dryRun(executorSigner, POOL, repayData(1n, { onBehalfOf: reserve }))).toMatch(/^ConditionViolation/);
  });
  it("R4: borrow, withdraw, supply, and repay with another asset or rate mode revert", async () => {
    const pool = (fn: string, args: unknown[]) => encodeFunctionData({ abi: [
      { type: "function", name: "borrow", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint16" }, { type: "address" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "withdraw", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
      { type: "function", name: "supply", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint16" }], outputs: [], stateMutability: "nonpayable" },
    ], functionName: fn as never, args: args as never });
    for (const d of [pool("borrow", [USDC, 1n, 2n, 0, main]), pool("withdraw", [USDC, 1n, reserve]), pool("supply", [USDC, 1n, reserve, 0])]) {
      expect(await dryRun(executorSigner, POOL, d)).toBe("ConditionViolation:FunctionNotAllowed");
    }
    expect(await dryRun(executorSigner, POOL, repayData(1n, { rate: 1n }))).toBe("ConditionViolation:ParameterNotAllowed");
    expect(await dryRun(executorSigner, POOL, repayData(1n, { asset: WETH }))).toBe("ConditionViolation:ParameterNotAllowed");
  });
  it("R5: another target (USDC transfer or approve, WETH, a plain ETH send) reverts", async () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [executorSigner.address, 1n] });
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [executorSigner.address, 1n] });
    expect(await dryRun(executorSigner, USDC, transfer)).toBe("ConditionViolation:TargetAddressNotAllowed");
    expect(await dryRun(executorSigner, USDC, approve)).toBe("ConditionViolation:TargetAddressNotAllowed");
    expect(await dryRun(executorSigner, WETH, transfer)).toBe("ConditionViolation:TargetAddressNotAllowed");
    expect(await dryRun(executorSigner, executorSigner.address, "0x", { value: 1n })).toBe("ConditionViolation:TargetAddressNotAllowed");
  });
  it("R6: a delegate call through the role reverts", async () => {
    expect(await dryRun(executorSigner, POOL, repayData(1n), { operation: 1 })).toBe("ConditionViolation:DelegateCallNotAllowed");
  });
  it("R7: after the period the allowance refills to the limit and not above", async () => {
    await roleRepay(parseUnits("1000", 6));
    expect(await allowanceLeft()).toBe(0n);
    await fork.testClient.increaseTime({ seconds: 86_400 + 5 });
    await fork.testClient.mine({ blocks: 1 });
    expect(await allowanceLeft()).toBe(LIMIT); // lazy: computed, the stored balance is still 0
    expect((await roleRepay(parseUnits("800", 6))).status).toBe("success");
    await fork.testClient.increaseTime({ seconds: 3 * 86_400 });
    await fork.testClient.mine({ blocks: 1 });
    expect(await allowanceLeft()).toBe(LIMIT); // capped at the limit, not 200 + 3 days of refill
    expect((await roleRepay(parseUnits("1", 6))).status).toBe("success");
    expect(await allowanceLeft()).toBe(LIMIT - parseUnits("1", 6));
  });
  it("R8: after the owners remove the member, or zero the allowance, the executor's call reverts", async () => {
    const off = encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [executorSigner.address, [ROLE_KEY], [false]] });
    const tx = { to: roles, value: "0", data: off, operation: 0 as const, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000" as Address, refundReceiver: "0x0000000000000000000000000000000000000000" as Address, nonce: String(await client.readContract({ address: reserve, abi: [{ type: "function", name: "nonce", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }], functionName: "nonce" })) };
    expect((await execSafeTx(fork, reserve, tx, [ANVIL_KEYS[0], ANVIL_KEYS[1]])).success).toBe(true);
    expect(await dryRun(executorSigner, POOL, repayData(1n))).toBe("NoMembership");
    const chain = (await readReserveChain(client, { chainId: 8453, reserve, roles, mainSafe: main, executor: executorSigner.address, fromBlock }))!;
    expect(chain.executorIsMember).toBe(false);
  });
  it("R9: a key that is not the member reverts", async () => {
    expect(await dryRun(attacker, POOL, repayData(1n))).toMatch(/^(NotAuthorized|NoMembership)$/);
  });
  it("R12: a request above the debt only takes the debt, and the allowance is charged the requested amount", async () => {
    // Repay nearly all so the debt is small, then ask for more than the debt.
    const debt = await debtOf();
    await setUsdc(reserve, parseUnits("100000", 6));
    // Make the limit large enough: raise the allowance through the owners is not needed; use two days of refills.
    let remaining = debt - parseUnits("150", 6);
    while (remaining > 0n) {
      const step = remaining > LIMIT ? LIMIT : remaining;
      await roleRepay(step);
      remaining -= step;
      if (remaining > 0n) { await fork.testClient.increaseTime({ seconds: 86_400 + 1 }); await fork.testClient.mine({ blocks: 1 }); }
    }
    await fork.testClient.increaseTime({ seconds: 86_400 + 1 });
    await fork.testClient.mine({ blocks: 1 });
    const dust = await debtOf();
    expect(dust).toBeLessThan(parseUnits("200", 6));
    const rb = await bal(USDC, reserve);
    expect((await roleRepay(parseUnits("900", 6))).status).toBe("success");
    expect(await debtOf()).toBe(0n);
    expect(rb - (await bal(USDC, reserve))).toBeLessThanOrEqual(dust + 10n); // only the debt left the Reserve
    expect(await allowanceLeft()).toBe(parseUnits("100", 6)); // charged 900
  });
});
