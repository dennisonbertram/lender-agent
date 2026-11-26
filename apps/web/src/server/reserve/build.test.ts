import { decodeFunctionData, getAddress, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { encodeMultiSendTransactions } from "@/server/safe/multisend";
import type { Address } from "@/shared/types";
import { buildReserveSetup, buildReserveRestore, buildRoleRepay, predictRolesProxy, repayConditions, reserveSaltNonce, rolesInitializer } from "./build";
import { ALLOWANCE_KEY, MODULE_PROXY_FACTORY, MULTISEND_CALL_ONLY, REPAY_SELECTOR, RESERVE_ASSET, ROLE_KEY, ROLES_V2_MASTERCOPY } from "./constants";
import { ExecOptions, Op, ParamType, rolesAbi, safeModuleAbi } from "./roles-abi";

const reserve = "0x62E792D80164fdc892237Ee4267552E6eeb1651a" as Address;
const main = "0xBbceD41A64edAb661586A660c5E3421f55A83564" as Address;
const executor = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const { pool, usdc } = RESERVE_ASSET[8453]!;
const input = { chainId: 8453 as const, reserveSafe: reserve, mainSafe: main, executor, dailyLimit: 1_000_000_000n, nowSec: 1_800_000_000 };

describe("Reserve setup calldata (offline, no hosted Zodiac API)", () => {
  it("pins the constants to the plan: Roles v2 mastercopy, ModuleProxyFactory, the role and the allowance keys", () => {
    expect(ROLES_V2_MASTERCOPY).toBe("0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5");
    expect(MODULE_PROXY_FACTORY).toBe("0x000000000000aDdB49795b0f9bA5BC298cDda236");
    expect(ROLE_KEY).toBe("0x726573657276652d6578656375746f7200000000000000000000000000000000"); // "reserve-executor"
    expect(ALLOWANCE_KEY).toBe("0x6461696c792d7265706179000000000000000000000000000000000000000000"); // "daily-repay"
    expect(REPAY_SELECTOR).toBe(keccak256(toHex("repay(address,uint256,uint256,address)")).slice(0, 10));
  });

  it("pins every repay parameter: asset, rate mode and onBehalfOf EqualTo, amount WithinAllowance (zodiac-roles-sdk 3.4.8 output)", () => {
    const rows = repayConditions(8453, main);
    expect(rows.map((r) => [r.parent, r.paramType, r.operator])).toEqual([
      [0, ParamType.Calldata, Op.Matches], [0, ParamType.Static, Op.EqualTo], [0, ParamType.Static, Op.WithinAllowance], [0, ParamType.Static, Op.EqualTo], [0, ParamType.Static, Op.EqualTo],
    ]);
    expect(rows[1]!.compValue).toBe(`0x${"0".repeat(24)}${usdc.slice(2).toLowerCase()}`);
    expect(rows[2]!.compValue).toBe(ALLOWANCE_KEY);
    expect(rows[3]!.compValue).toBe(`0x${"0".repeat(63)}2`);
    expect(rows[4]!.compValue).toBe(`0x${"0".repeat(24)}${main.slice(2).toLowerCase()}`);
  });

  it("builds one MultiSendCallOnly delegatecall: deploy, enable, assign, scope target, scope repay, allowance, approve", () => {
    const s = buildReserveSetup(input, 7);
    expect(s.tx.to).toBe(MULTISEND_CALL_ONLY);
    expect(s.tx.operation).toBe(1);
    expect(s.tx.nonce).toBe("7");
    expect(s.tx.data).toContain(encodeMultiSendTransactions(s.calls).slice(2));
    expect(s.calls).toHaveLength(7);
    expect(s.calls.map((c) => getAddress(c.to))).toEqual([MODULE_PROXY_FACTORY, reserve, s.roles, s.roles, s.roles, s.roles, usdc].map((a) => getAddress(a)));
    const names = s.calls.slice(1, 6).map((c) => decodeFunctionData({ abi: [...rolesAbi, ...safeModuleAbi], data: c.data! }).functionName);
    expect(names).toEqual(["enableModule", "assignRoles", "scopeTarget", "scopeFunction", "setAllowance"]);
    const allow = decodeFunctionData({ abi: rolesAbi, data: s.calls[5]!.data! });
    expect(allow.args).toEqual([ALLOWANCE_KEY, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 86_400n, BigInt(input.nowSec)]);
    const scope = decodeFunctionData({ abi: rolesAbi, data: s.calls[4]!.data! });
    expect(scope.args![1]).toBe(pool);
    expect(scope.args![2]).toBe(REPAY_SELECTOR);
    expect(scope.args![4]).toBe(ExecOptions.None);
  });

  it("restores a freshly revoked reviewed Roles module without deploying or enabling another module", () => {
    const previous = buildReserveSetup(input, 7);
    const restored = buildReserveRestore({ ...input, roles: previous.roles, originalSaltNonce: previous.saltNonce, dailyLimit: 1_000_123_456n }, 8);
    expect(restored.roles).toBe(previous.roles);
    expect(restored.saltNonce).toBe(previous.saltNonce);
    expect(restored.calls.map((c) => getAddress(c.to))).toEqual([restored.roles, restored.roles, restored.roles, restored.roles, usdc].map((a) => getAddress(a)));
    const names = restored.calls.slice(0, 4).map((c) => decodeFunctionData({ abi: rolesAbi, data: c.data! }).functionName);
    expect(names).toEqual(["assignRoles", "scopeTarget", "scopeFunction", "setAllowance"]);
    const allow = decodeFunctionData({ abi: rolesAbi, data: restored.calls[3]!.data! });
    expect(allow.args).toEqual([ALLOWANCE_KEY, 1_000_123_456n, 1_000_123_456n, 1_000_123_456n, 86_400n, BigInt(input.nowSec)]);
  });

  it("gives the role no approve, no token target, no send and no delegatecall: only Pool.repay is scoped", () => {
    const s = buildReserveSetup(input);
    const roleCalls = s.calls.filter((c) => c.to === s.roles).map((c) => decodeFunctionData({ abi: rolesAbi, data: c.data! }));
    const targets = roleCalls.filter((d) => d.functionName === "scopeTarget" || d.functionName === "scopeFunction").map((d) => (d.args as unknown as unknown[])[1]);
    expect(new Set(targets)).toEqual(new Set([pool]));
    expect(roleCalls.some((d) => (d.functionName as string) === "allowTarget" || (d.functionName as string) === "allowFunction")).toBe(false);
  });

  it("predicts the proxy address from mastercopy, initializer and salt (the fork test deploys exactly there) and differs per Reserve and attempt", () => {
    const s = buildReserveSetup(input);
    expect(s.roles).toBe(predictRolesProxy({ reserveSafe: reserve, saltNonce: BigInt(s.saltNonce) }));
    expect(buildReserveSetup({ ...input, attempt: 1 }).roles).not.toBe(s.roles);
    expect(buildReserveSetup({ ...input, reserveSafe: "0x0000000000000000000000000000000000000abc" }).roles).not.toBe(s.roles);
    expect(reserveSaltNonce({ reserveSafe: reserve, mainSafe: main, executor })).toBe(BigInt(s.saltNonce));
    expect(rolesInitializer(reserve).startsWith("0xa4f9edbf")).toBe(true); // setUp(bytes)
  });

  it("refuses a zero or oversized limit, the main Safe as its own Reserve, and a network without a Reserve", () => {
    expect(() => buildReserveSetup({ ...input, dailyLimit: 0n })).toThrow("above zero");
    expect(() => buildReserveSetup({ ...input, dailyLimit: 2n ** 128n })).toThrow("too large");
    expect(() => buildReserveSetup({ ...input, reserveSafe: main })).toThrow("different Safe");
    expect(() => buildReserveSetup({ ...input, chainId: 84532 })).toThrow("not offered");
  });

  it("the executor's repay is execTransactionWithRole(Pool, 0, repay(USDC, amount, 2, main), call, role, shouldRevert)", () => {
    const r = buildRoleRepay({ chainId: 8453, roles: "0x00000000000000000000000000000000000000aa", mainSafe: main, amount: 5_000_000n });
    const d = decodeFunctionData({ abi: rolesAbi, data: r.data });
    expect(d.functionName).toBe("execTransactionWithRole");
    const [to, value, , operation, role, shouldRevert] = d.args as unknown as [Address, bigint, string, number, string, boolean];
    expect([to, value, operation, role, shouldRevert]).toEqual([pool, 0n, 0, ROLE_KEY, true]);
  });
});
