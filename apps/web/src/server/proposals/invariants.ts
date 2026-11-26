// Batch invariants (architecture section 2, rule 4). Run after the build and the simulation, before
// anything is signed. A failure is an error: the proposal is not offered.
import { decodeFunctionData, encodeAbiParameters, getAddress, isAddressEqual, keccak256, type Abi, type Hex } from "viem";
import { cometAbi, morphoAbi } from "@/server/lenders/abis";
import { COMET_USDC_BASE, MARKET_ALLOWLIST, MORPHO_BLUE } from "@/server/lenders/allowlist";
import { erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { AAVE, ALLOWLIST, MULTISEND_CALL_ONLY, tokenBySymbol } from "@/server/chain/config";
import { encodeMultiSend, type Call } from "@/server/safe/multisend";
import type { Address, ChainId, SafeTx } from "@/shared/types";

export type InvariantResult = { ok: true } | { ok: false; reason: string };

export type InvariantInput = {
  chainId: ChainId;
  safe: Address;
  calls: (Call & { operation?: number })[];
  outer: SafeTx;
  /** "adds": opens or increases debt. "reduces": repay or added collateral. */
  risk: "adds" | "reduces";
  healthBefore: number | null;
  healthAfter: number | null;
  simulationOk: boolean;
};

const fail = (reason: string): InvariantResult => ({ ok: false, reason });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

function decode(abi: Abi, data: Hex) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null;
  }
}

const lenderContracts = (chainId: ChainId): Address[] => (chainId === 8453 ? [COMET_USDC_BASE, MORPHO_BLUE].map((a) => a.toLowerCase() as Address) : []);
const MARKET_TUPLE = [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] as const;

/** Calls into Compound v3 and Morpho Blue (BP-32): the Safe is always the account and the receiver, and Morpho only for allowlisted market ids. */
function checkLenderCall(chainId: ChainId, safe: Address, to: string, c: Call, at: string): string | null {
  if (BigInt(c.value ?? 0) !== 0n) return `${at} sends ETH to the lender`;
  const data = (c.data ?? "0x") as Hex;
  if (same(to, COMET_USDC_BASE)) {
    const d = decode(cometAbi, data);
    if (!d) return `${at} calls an unknown function on the lender`;
    const args = d.args as readonly unknown[];
    if (d.functionName === "supplyTo") {
      if (!isAddressEqual(args[0] as Address, safe)) return `${at} (supplyTo) acts for ${args[0]}, not the Safe`;
      return ALLOWLIST[chainId].includes((args[1] as string).toLowerCase() as Address) ? null : `${at} uses ${args[1]}, which is not on the allowlist`;
    }
    if (d.functionName === "supply" || d.functionName === "withdraw") return ALLOWLIST[chainId].includes((args[0] as string).toLowerCase() as Address) ? null : `${at} uses ${args[0]}, which is not on the allowlist`;
    return `${at} calls ${d.functionName} on the lender, which is not allowed`;
  }
  const d = decode(morphoAbi, data);
  if (!d) return `${at} calls an unknown function on the lender`;
  const args = d.args as readonly unknown[];
  const id = keccak256(encodeAbiParameters([{ type: "tuple", components: MARKET_TUPLE }], [args[0] as never]));
  if (!MARKET_ALLOWLIST.some((m) => m.lender === "morpho-blue" && m.marketId.toLowerCase() === id)) return `${at} uses a Morpho market that is not on the allowlist`;
  // Morpho Blue's argument positions differ per function (see `morphoAbi`):
  //   supplyCollateral(params, assets, onBehalf, data)
  //   withdrawCollateral(params, assets, onBehalf, receiver)
  //   borrow(params, assets, shares, onBehalf, receiver)
  //   repay(params, assets, shares, onBehalf, data)
  const who = (i: number) => isAddressEqual(args[i] as Address, safe);
  switch (d.functionName) {
    case "supplyCollateral": return who(2) ? null : `${at} (supplyCollateral) acts on behalf of ${args[2]}, not the Safe`;
    case "repay": return who(3) ? null : `${at} (repay) acts on behalf of ${args[3]}, not the Safe`;
    case "borrow": return who(3) && who(4) ? null : `${at} (borrow) acts for or pays someone other than the Safe`;
    case "withdrawCollateral": return who(2) && who(3) ? null : `${at} (withdrawCollateral) acts for or pays someone other than the Safe`;
    default: return `${at} calls ${d.functionName} on the lender, which is not allowed`;
  }
}

/** Why one call is not allowed, or null. */
function checkCall(chainId: ChainId, safe: Address, c: Call & { operation?: number }, i: number): string | null {
  const at = `step ${i + 1}`;
  const aave = AAVE[chainId];
  if (!aave) return "no lender is configured for this network";
  if ((c.operation ?? 0) !== 0) return `${at} is a delegate call`;
  const to = c.to.toLowerCase();
  if (lenderContracts(chainId).includes(to as Address)) return checkLenderCall(chainId, safe, to, c, at);
  if (!ALLOWLIST[chainId].includes(to as Address)) return `${at} targets ${c.to}, which is not on the allowlist`;
  if (same(to, MULTISEND_CALL_ONLY)) return `${at} calls the batch contract from inside the batch`;
  const value = BigInt(c.value ?? 0);
  const data = (c.data ?? "0x") as Hex;
  const weth = tokenBySymbol(chainId, "WETH")?.address;
  const isWeth = !!weth && same(to, weth);

  if (same(to, aave.pool)) {
    if (value !== 0n) return `${at} sends ETH to the lender`;
    const d = decode(poolAbi, data);
    if (!d) return `${at} calls an unknown function on the lender`;
    const args = d.args as readonly unknown[];
    const asset = args[0] as Address;
    switch (d.functionName) {
      case "supply":
      case "borrow":
      case "repay": {
        const onBehalfOf = (d.functionName === "supply" ? args[2] : d.functionName === "borrow" ? args[4] : args[3]) as Address;
        if (!isAddressEqual(onBehalfOf, safe)) return `${at} (${d.functionName}) acts on behalf of ${onBehalfOf}, not the Safe`;
        break;
      }
      case "withdraw":
        if (!isAddressEqual(args[2] as Address, safe)) return `${at} (withdraw) pays ${args[2]}, not the Safe`;
        break;
      default:
        return `${at} calls ${d.functionName} on the lender, which is not allowed`;
    }
    if (!ALLOWLIST[chainId].includes(asset.toLowerCase() as Address)) return `${at} uses ${asset}, which is not on the allowlist`;
    return null;
  }

  // A token contract.
  const abi = (isWeth ? [...erc20Abi, ...wethAbi] : erc20Abi) as Abi;
  const d = decode(abi, data);
  if (!d) return `${at} calls an unknown function on a token`;
  const args = (d.args ?? []) as readonly unknown[];
  switch (d.functionName) {
    case "approve":
      if (value !== 0n) return `${at} sends ETH with an approval`;
      if (!isAddressEqual(args[0] as Address, aave.pool) && !lenderContracts(chainId).includes((args[0] as string).toLowerCase() as Address)) return `${at} approves ${args[0]}, not the lender`;
      return null;
    case "transfer":
      if (value !== 0n) return `${at} sends ETH with a transfer`;
      if (!isAddressEqual(args[0] as Address, safe)) return `${at} sends tokens to ${args[0]}, not the Safe`;
      return null;
    case "deposit":
      return isWeth ? null : `${at} calls deposit on a token that is not WETH`;
    case "withdraw":
      if (!isWeth) return `${at} calls withdraw on a token that is not WETH`;
      return value === 0n ? null : `${at} sends ETH with a WETH withdraw`;
    default:
      return `${at} calls ${d.functionName}, which is not allowed`;
  }
}

/** The outer Safe transaction must be exactly what the checked calls produce. */
function checkOuter(chainId: ChainId, calls: InvariantInput["calls"], outer: SafeTx): string | null {
  if (outer.gasPrice !== "0" || outer.safeTxGas !== "0" || outer.baseGas !== "0") return "the transaction asks the Safe to refund gas";
  if (!same(outer.gasToken, ZERO) || !same(outer.refundReceiver, ZERO)) return "the transaction names a refund receiver";
  if (outer.operation === 1) {
    if (!same(outer.to, MULTISEND_CALL_ONLY)) return "a delegate call must go to the batch contract (MultiSendCallOnly)";
    if (BigInt(outer.value) !== 0n) return "the batch transaction carries ETH";
    let expected: Hex;
    try {
      expected = encodeMultiSend(calls);
    } catch (e) {
      return (e as Error).message;
    }
    if (outer.data.toLowerCase() !== expected.toLowerCase()) return "the transaction does not match the checked calls";
    return null;
  }
  if (outer.operation !== 0) return "unknown operation";
  if (calls.length !== 1) return "a plain transaction must hold exactly one call";
  const c = calls[0]!;
  if (!same(outer.to, c.to) || BigInt(outer.value) !== BigInt(c.value ?? 0) || outer.data.toLowerCase() !== (c.data ?? "0x").toLowerCase()) {
    return "the transaction does not match the checked calls";
  }
  void chainId;
  return null;
}

export function checkInvariants(p: InvariantInput): InvariantResult {
  if (p.calls.length === 0) return fail("the batch is empty");
  let safe: Address;
  try {
    safe = getAddress(p.safe);
  } catch {
    return fail("the Safe address is invalid");
  }
  for (const [i, c] of p.calls.entries()) {
    const why = checkCall(p.chainId, safe, c, i);
    if (why) return fail(why);
  }
  const outer = checkOuter(p.chainId, p.calls, p.outer);
  if (outer) return fail(outer);
  if (!p.simulationOk) return fail("the test run failed");
  const after = p.healthAfter;
  if (after === null || Number.isNaN(after)) return fail("the health factor after the test run is unknown");
  if (p.risk === "adds") {
    if (after < 1) return fail(`this would leave the health factor at ${after.toFixed(2)}, below 1.0`);
  } else if (after !== Number.POSITIVE_INFINITY && !(p.healthBefore === null || after > p.healthBefore)) {
    return fail(`this does not raise the health factor (${p.healthBefore.toFixed(2)} → ${after.toFixed(2)})`);
  }
  return { ok: true };
}
