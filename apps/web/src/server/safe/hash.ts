// EIP-712 hashes and typed data for Safe 1.4.1 and the Transaction Service (M0-1, M0-3).
import { hashTypedData } from "viem";
import type { Address, ChainId, Hex, SafeTx } from "@/shared/types";
import { TX_SERVICE_DOMAIN } from "./constants";

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function safeTxTypedData(chainId: ChainId, safe: Address, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: {
      to: tx.to,
      value: BigInt(tx.value),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: BigInt(tx.safeTxGas),
      baseGas: BigInt(tx.baseGas),
      gasPrice: BigInt(tx.gasPrice),
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: BigInt(tx.nonce),
    },
  };
}

/** The Safe contract's `getTransactionHash` for this transaction. */
export function safeTxHash(chainId: ChainId, safe: Address, tx: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, tx));
}

/** The Transaction Service's time counter: the current hour. */
export function currentTotp(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / 3600);
}

/** Owner signs this to add or remove a delegate. Pass `safe` to scope it (M0-1); the typed data is the same. */
export function delegateTypedData(chainId: ChainId, delegate: Address, totp: number = currentTotp()) {
  return {
    domain: { ...TX_SERVICE_DOMAIN, chainId },
    types: {
      Delegate: [
        { name: "delegateAddress", type: "address" },
        { name: "totp", type: "uint256" },
      ],
    },
    primaryType: "Delegate" as const,
    message: { delegateAddress: delegate, totp: BigInt(totp) },
  };
}

/** The agent signs this to delete its own proposal (M0-3). The Safe is the verifying contract. */
export function deleteRequestTypedData(chainId: ChainId, safe: Address, safeTxHash: Hex, totp: number = currentTotp()) {
  return {
    domain: { ...TX_SERVICE_DOMAIN, chainId, verifyingContract: safe },
    types: {
      DeleteRequest: [
        { name: "safeTxHash", type: "bytes32" },
        { name: "totp", type: "uint256" },
      ],
    },
    primaryType: "DeleteRequest" as const,
    message: { safeTxHash, totp: BigInt(totp) },
  };
}
