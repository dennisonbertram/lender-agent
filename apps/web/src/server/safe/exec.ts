// execTransaction calldata for a stored Safe transaction.
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { SafeTx } from "@/shared/types";

export const execTransactionAbi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
  "function approveHash(bytes32 hashToApprove)",
]);

export function execCalldata(tx: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: execTransactionAbi,
    functionName: "execTransaction",
    args: [tx.to, BigInt(tx.value), tx.data, tx.operation, BigInt(tx.safeTxGas), BigInt(tx.baseGas), BigInt(tx.gasPrice), tx.gasToken, tx.refundReceiver, signatures],
  });
}

/** True when `input` is an execTransaction call carrying exactly this transaction's fields (any signatures). */
export function execCalldataMatches(input: Hex, tx: SafeTx): boolean {
  try {
    const d = decodeFunctionData({ abi: execTransactionAbi, data: input });
    if (d.functionName !== "execTransaction") return false;
    const a = d.args as readonly [string, bigint, Hex, number, bigint, bigint, bigint, string, string, Hex];
    return a[0].toLowerCase() === tx.to.toLowerCase() && a[1] === BigInt(tx.value) && a[2].toLowerCase() === tx.data.toLowerCase()
      && a[3] === tx.operation && a[4] === BigInt(tx.safeTxGas) && a[5] === BigInt(tx.baseGas) && a[6] === BigInt(tx.gasPrice)
      && a[7].toLowerCase() === tx.gasToken.toLowerCase() && a[8].toLowerCase() === tx.refundReceiver.toLowerCase();
  } catch {
    return false;
  }
}
