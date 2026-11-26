// MultiSendCallOnly batches (architecture 8.1). Inner delegate calls are refused.
import { concatHex, encodeFunctionData, encodePacked, getAddress, size, type Hex } from "viem";
import type { Address, SafeTx } from "@/shared/types";
import { MULTISEND_CALL_ONLY, ZERO_ADDRESS } from "./constants";

export type Call = { to: Address; value?: bigint | string; data?: Hex };

export const multiSendAbi = [
  {
    type: "function",
    name: "multiSend",
    stateMutability: "payable",
    inputs: [{ name: "transactions", type: "bytes" }],
    outputs: [],
  },
] as const;

/** Packed encoding: operation (1) | to (20) | value (32) | dataLength (32) | data. */
export function encodeMultiSendTransactions(calls: (Call & { operation?: number })[]): Hex {
  if (calls.length === 0) throw new Error("multisend needs at least one call");
  return concatHex(
    calls.map((c) => {
      if ((c.operation ?? 0) !== 0) throw new Error("multisend: inner delegate call (operation 1) is not allowed");
      const data = c.data ?? "0x";
      return encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [0, c.to, BigInt(c.value ?? 0), BigInt(size(data)), data],
      );
    }),
  );
}

export function encodeMultiSend(calls: (Call & { operation?: number })[]): Hex {
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [encodeMultiSendTransactions(calls)] });
}

/**
 * Build the outer SafeTx for one or more calls. One call is a plain call (operation 0);
 * several go through MultiSendCallOnly with operation 1. Gas fields are zero (no refund).
 */
export function buildSafeTx(calls: (Call & { operation?: number })[], nonce: bigint | number | string): SafeTx {
  if (calls.length === 0) throw new Error("no calls");
  const base = {
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: String(nonce),
  };
  if (calls.length === 1) {
    const c = calls[0]!;
    if ((c.operation ?? 0) !== 0) throw new Error("delegate call (operation 1) is not allowed");
    return { to: getAddress(c.to), value: String(c.value ?? 0), data: c.data ?? "0x", operation: 0, ...base };
  }
  return { to: MULTISEND_CALL_ONLY, value: "0", data: encodeMultiSend(calls), operation: 1, ...base };
}
