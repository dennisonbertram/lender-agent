// Offline calldata for the Reserve setup (spike M0-6, architecture 8.4). No network, no hosted Zodiac API.
// One Safe transaction from the Reserve Safe's owners: deploy the Roles v2 modifier through the
// ModuleProxyFactory, enable it, assign the executor to the role, scope Pool.repay (asset, mode and
// onBehalfOf pinned, amount WithinAllowance), set the daily allowance, approve the Pool once.
// The role gets no `approve`, no token target, no delegatecall and no send.
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, pad, toHex, type Hex } from "viem";
import { buildSafeTx, type Call } from "@/server/safe/multisend";
import type { Address, ChainId, SafeTx } from "@/shared/types";
import {
  ALLOWANCE_KEY, ALLOWANCE_PERIOD_SEC, MODULE_PROXY_FACTORY, REPAY_SELECTOR, RESERVE_ASSET, ROLES_V2_MASTERCOPY, ROLE_KEY, VARIABLE_RATE_MODE,
} from "./constants";
import { ExecOptions, Op, ParamType, erc20Abi, moduleProxyFactoryAbi, rolesAbi, safeModuleAbi } from "./roles-abi";

export type ConditionFlat = { parent: number; paramType: number; operator: number; compValue: Hex };

const word = (v: bigint | Address): Hex => pad(typeof v === "bigint" ? toHex(v) : (v.toLowerCase() as Hex), { size: 32 });

/** The five condition rows of `repay(asset, amount, rateMode, onBehalfOf)`: every parameter is pinned. */
export function repayConditions(chainId: ChainId, mainSafe: Address): ConditionFlat[] {
  const a = RESERVE_ASSET[chainId];
  if (!a) throw new Error(`The Reserve is not offered on network ${chainId}.`);
  return [
    { parent: 0, paramType: ParamType.Calldata, operator: Op.Matches, compValue: "0x" },
    { parent: 0, paramType: ParamType.Static, operator: Op.EqualTo, compValue: word(a.usdc) },
    { parent: 0, paramType: ParamType.Static, operator: Op.WithinAllowance, compValue: ALLOWANCE_KEY },
    { parent: 0, paramType: ParamType.Static, operator: Op.EqualTo, compValue: word(VARIABLE_RATE_MODE) },
    { parent: 0, paramType: ParamType.Static, operator: Op.EqualTo, compValue: word(mainSafe) },
  ];
}

/** Salt nonce: unique per (Reserve Safe, main Safe, executor, attempt). Attempt 0 is the first setup. */
export function reserveSaltNonce(p: { reserveSafe: Address; mainSafe: Address; executor: Address; attempt?: number }): bigint {
  return BigInt(keccak256(toHex(`lender-agent/reserve/v1/${p.reserveSafe}/${p.mainSafe}/${p.executor}/${p.attempt ?? 0}`.toLowerCase())));
}

/** `setUp(abi.encode(owner, avatar, target))`: the Reserve Safe is owner, avatar and target. */
export function rolesInitializer(reserveSafe: Address): Hex {
  const params = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [reserveSafe, reserveSafe, reserveSafe]);
  return encodeFunctionData({ abi: rolesAbi, functionName: "setUp", args: [params] });
}

/** The proxy address the factory will create (EIP-1167 style clone, CREATE2 from the factory). Equal to the factory event's proxy. */
export function predictRolesProxy(p: { reserveSafe: Address; saltNonce: bigint; mastercopy?: Address; factory?: Address }): Address {
  const master = (p.mastercopy ?? ROLES_V2_MASTERCOPY).toLowerCase().slice(2);
  const bytecode = `0x602d8060093d393df3363d3d373d3d3d363d73${master}5af43d82803e903d91602b57fd5bf3` as Hex;
  const salt = keccak256(concatHex([keccak256(rolesInitializer(p.reserveSafe)), pad(toHex(p.saltNonce), { size: 32 })]));
  return getContractAddress({ opcode: "CREATE2", from: p.factory ?? MODULE_PROXY_FACTORY, salt, bytecode });
}

export type ReserveSetupInput = {
  chainId: ChainId;
  reserveSafe: Address;
  mainSafe: Address;
  /** The reserve executor key's address (never the proposer key). */
  executor: Address;
  /** Whole USDC per day, as raw 6-decimal units. */
  dailyLimit: bigint;
  /** Current time in seconds: the allowance period starts here. */
  nowSec: number;
  attempt?: number;
};

export type ReserveSetup = {
  chainId: ChainId;
  reserveSafe: Address;
  mainSafe: Address;
  executor: Address;
  roles: Address;
  saltNonce: string;
  /** The inner calls, in order. */
  calls: Call[];
  /** What the owners see, one line per call that matters. */
  steps: string[];
  /** The Safe transaction (MultiSend delegatecall) at `nonce`. */
  tx: SafeTx;
  dailyLimit: bigint;
};

/** Build the whole setup batch as one Safe transaction. Pure: nothing is read or sent. */
export function buildReserveSetup(input: ReserveSetupInput, nonce: bigint | number | string = 0): ReserveSetup {
  const { chainId } = input;
  const a = RESERVE_ASSET[chainId];
  if (!a) throw new Error(`The Reserve is not offered on network ${chainId}.`);
  if (input.dailyLimit <= 0n) throw new Error("The daily limit must be above zero.");
  if (input.dailyLimit >= 2n ** 128n) throw new Error("The daily limit is too large.");
  const reserveSafe = getAddress(input.reserveSafe) as Address;
  const mainSafe = getAddress(input.mainSafe) as Address;
  const executor = getAddress(input.executor) as Address;
  if (reserveSafe.toLowerCase() === mainSafe.toLowerCase()) throw new Error("The Reserve Safe must be a different Safe from the main Safe.");
  const saltNonce = reserveSaltNonce({ reserveSafe, mainSafe, executor, attempt: input.attempt });
  const roles = predictRolesProxy({ reserveSafe, saltNonce });
  const limit = input.dailyLimit;

  const calls: Call[] = [
    { to: MODULE_PROXY_FACTORY, data: encodeFunctionData({ abi: moduleProxyFactoryAbi, functionName: "deployModule", args: [ROLES_V2_MASTERCOPY, rolesInitializer(reserveSafe), saltNonce] }) },
    { to: reserveSafe, data: encodeFunctionData({ abi: safeModuleAbi, functionName: "enableModule", args: [roles] }) },
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [executor, [ROLE_KEY], [true]] }) },
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "scopeTarget", args: [ROLE_KEY, a.pool] }) },
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "scopeFunction", args: [ROLE_KEY, a.pool, REPAY_SELECTOR, repayConditions(chainId, mainSafe), ExecOptions.None] }) },
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "setAllowance", args: [ALLOWANCE_KEY, limit, limit, limit, BigInt(ALLOWANCE_PERIOD_SEC), BigInt(input.nowSec)] }) },
    // Signed once here so the role needs no `approve` permission (architecture 8.4). Only the Pool can pull, and only what `repay` asks.
    { to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.pool, 2n ** 256n - 1n] }) },
  ];
  const steps = [
    "Create the permission module on the Reserve Safe",
    "Turn the module on",
    "Let the agent's reserve key use one role",
    "Allow that role to repay USDC debt on Aave, for the main Safe only",
    "Cap what the role may request at the daily limit",
    "Let Aave take the repayment from the Reserve Safe",
  ];
  return { chainId, reserveSafe, mainSafe, executor, roles, saltNonce: saltNonce.toString(), calls, steps, tx: buildSafeTx(calls, nonce), dailyLimit: limit };
}

/**
 * Re-authorize a previously reviewed Roles proxy after a confirmed revoke. Callers must freshly
 * verify that this exact module remains enabled, its scope is unchanged, and the executor is no
 * longer a member. Owners still approve one new Safe transaction; no second module is deployed.
 */
export function buildReserveRestore(input: ReserveSetupInput & { roles: Address; originalSaltNonce: string }, nonce: bigint | number | string = 0): ReserveSetup {
  const { chainId } = input;
  const a = RESERVE_ASSET[chainId];
  if (!a) throw new Error(`The Reserve is not offered on network ${chainId}.`);
  if (input.dailyLimit <= 0n) throw new Error("The daily limit must be above zero.");
  if (input.dailyLimit >= 2n ** 128n) throw new Error("The daily limit is too large.");
  const reserveSafe = getAddress(input.reserveSafe) as Address;
  const mainSafe = getAddress(input.mainSafe) as Address;
  const executor = getAddress(input.executor) as Address;
  const roles = getAddress(input.roles) as Address;
  if (reserveSafe.toLowerCase() === mainSafe.toLowerCase()) throw new Error("The Reserve Safe must be a different Safe from the main Safe.");
  const limit = input.dailyLimit;
  const calls: Call[] = [
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [executor, [ROLE_KEY], [true]] }) },
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "scopeTarget", args: [ROLE_KEY, a.pool] }) },
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "scopeFunction", args: [ROLE_KEY, a.pool, REPAY_SELECTOR, repayConditions(chainId, mainSafe), ExecOptions.None] }) },
    { to: roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "setAllowance", args: [ALLOWANCE_KEY, limit, limit, limit, BigInt(ALLOWANCE_PERIOD_SEC), BigInt(input.nowSec)] }) },
    { to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.pool, 2n ** 256n - 1n] }) },
  ];
  const steps = [
    "Restore the reviewed permission module on the Reserve Safe",
    "Let the agent's reserve key use one role",
    "Allow that role to repay USDC debt on Aave, for the main Safe only",
    "Reset the daily limit",
    "Let Aave take the repayment from the Reserve Safe",
  ];
  return {
    chainId, reserveSafe, mainSafe, executor, roles, saltNonce: input.originalSaltNonce, calls, steps,
    tx: buildSafeTx(calls, nonce), dailyLimit: limit,
  };
}

/** The exact `execTransactionWithRole` call for a repay by the executor. `amount` is raw USDC units and is what the allowance counts. */
export function buildRoleRepay(p: { chainId: ChainId; roles: Address; mainSafe: Address; amount: bigint }): { to: Address; data: Hex } {
  const a = RESERVE_ASSET[p.chainId];
  if (!a) throw new Error(`The Reserve is not offered on network ${p.chainId}.`);
  const inner = encodeFunctionData({
    abi: [{ type: "function", name: "repay", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "interestRateMode", type: "uint256" }, { name: "onBehalfOf", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "repay", args: [a.usdc, p.amount, VARIABLE_RATE_MODE, p.mainSafe],
  });
  return { to: p.roles, data: encodeFunctionData({ abi: rolesAbi, functionName: "execTransactionWithRole", args: [a.pool, 0n, inner, 0, ROLE_KEY, true] }) };
}
