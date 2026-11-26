// The contracts a stored Safe transaction calls, for the proposal page (proposals-07). Pure; decodes the
// MultiSend batch the repo's encoder builds. Names come only from addresses the app already knows.
import { decodeFunctionData, getAddress, hexToBigInt, size, slice, toFunctionSelector, type Hex } from "viem";
import { AAVE, erc20Tokens } from "@/server/chain/config";
import { MULTISEND_CALL_ONLY } from "@/server/safe/constants";
import { multiSendAbi } from "@/server/safe/multisend";
import { COMET_USDC_BASE, MORPHO_BLUE } from "@/server/lenders/allowlist";
import { ROLES_V2_MASTERCOPY } from "@/server/reserve/constants";
import type { Address, ChainId, SafeTx } from "@/shared/types";

export type ProposalCall = { to: Address; name: string | null; value: string; selector: Hex | null; fn: string | null; /** A delegatecall: the called code runs as the Safe itself. */ delegate: boolean; /** The signed outer call of a delegatecall batch; the inner calls follow it. */ outer?: boolean; /** The outer call is a batch whose contents could not be decoded. */ unreadable?: boolean };

const SIGNATURES = [
  "approve(address,uint256)",
  "supply(address,uint256,address,uint16)",
  "borrow(address,uint256,uint256,uint16,address)",
  "repay(address,uint256,uint256,address)",
  "withdraw(address,uint256,address)",
  "withdraw(uint256)",
  "deposit()",
  "supply((address,address,address,address,uint256),uint256,uint256,address,bytes)",
  "supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "borrow((address,address,address,address,uint256),uint256,uint256,address,address)",
  "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)",
  "withdraw((address,address,address,address,uint256),uint256,uint256,address,address)",
  "withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
  "supply(address,uint256)",
  "supplyTo(address,address,uint256)",
  "withdraw(address,uint256)",
  "multiSend(bytes)",
];
const FN_BY_SELECTOR = new Map<string, string>(SIGNATURES.map((s) => [toFunctionSelector(s), s.slice(0, s.indexOf("("))]));

function nameOf(chainId: ChainId, to: string): string | null {
  const a = to.toLowerCase();
  if (a === AAVE[chainId]?.pool.toLowerCase()) return "Aave v3";
  if (chainId === 8453 && a === MORPHO_BLUE.toLowerCase()) return "Morpho";
  if (chainId === 8453 && a === COMET_USDC_BASE.toLowerCase()) return "Compound v3";
  if (a === MULTISEND_CALL_ONLY.toLowerCase()) return "MultiSendCallOnly";
  if (a === ROLES_V2_MASTERCOPY.toLowerCase()) return "Roles";
  return erc20Tokens(chainId).find((t) => t.address.toLowerCase() === a)?.symbol ?? null;
}

function callOf(chainId: ChainId, to: string, value: bigint, data: Hex, delegate = false): ProposalCall {
  const selector = size(data) >= 4 ? slice(data, 0, 4) : null;
  return { to: getAddress(to) as Address, name: nameOf(chainId, to), value: value.toString(), selector, fn: selector ? FN_BY_SELECTOR.get(selector) ?? null : null, delegate };
}

/** The packed payload: operation (1) | to (20) | value (32) | dataLength (32) | data. Null when it does not parse. */
function unpack(packed: Hex): { operation: number; to: Hex; value: bigint; data: Hex }[] | null {
  const out: { operation: number; to: Hex; value: bigint; data: Hex }[] = [];
  const total = size(packed);
  let at = 0;
  while (at < total) {
    if (at + 85 > total) return null;
    const len = Number(hexToBigInt(slice(packed, at + 53, at + 85)));
    if (at + 85 + len > total) return null;
    out.push({ operation: Number(hexToBigInt(slice(packed, at, at + 1))), to: slice(packed, at + 1, at + 21), value: hexToBigInt(slice(packed, at + 21, at + 53)), data: len === 0 ? "0x" : slice(packed, at + 85, at + 85 + len) });
    at += 85 + len;
  }
  return out.length ? out : null;
}

export function callsOf(chainId: ChainId, tx: SafeTx): ProposalCall[] {
  const call = callOf(chainId, tx.to, BigInt(tx.value || "0"), tx.data, tx.operation === 1);
  if (tx.operation !== 1) return [call];
  // The signed outer call is a delegatecall: always show its target, then what it unpacks to.
  const outer = { ...call, outer: true };
  if (tx.to.toLowerCase() !== MULTISEND_CALL_ONLY.toLowerCase()) return [outer];
  try {
    const d = decodeFunctionData({ abi: multiSendAbi, data: tx.data });
    const inner = unpack(d.args[0]);
    if (inner) return [outer, ...inner.map((c) => callOf(chainId, c.to, c.value, c.data, c.operation === 1))];
  } catch { /* falls through to unreadable */ }
  return [{ ...outer, unreadable: true }];
}
