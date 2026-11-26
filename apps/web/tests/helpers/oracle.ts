// Fork helpers for lender tests: replace a price source's code with a stub that answers every call
// with fixed 32-byte words, and credit USDC by writing its balance mapping (slot 9).
import { concatHex, encodeAbiParameters, keccak256, numberToHex, toHex, type Hex } from "viem";
import type { Address } from "@/shared/types";
import type { Fork } from "./anvil";

/** Runtime code that returns `words` (each 32 bytes) for any call. */
export function constantReturnCode(words: bigint[]): Hex {
  const parts: Hex[] = [];
  words.forEach((w, i) => {
    parts.push("0x7f", numberToHex(w, { size: 32 }), "0x60", numberToHex(i * 32, { size: 1 }), "0x52"); // PUSH32 w, PUSH1 off, MSTORE
  });
  parts.push("0x60", numberToHex(words.length * 32, { size: 1 }), "0x60", "0x00", "0xf3"); // PUSH1 len, PUSH1 0, RETURN
  return concatHex(parts);
}

export async function stubReturning(fork: Fork, at: Address, words: bigint[]) {
  await fork.testClient.setCode({ address: at, bytecode: constantReturnCode(words) });
}

const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Set `who`'s USDC balance (raw units) on the fork. */
export async function setUsdc(fork: Fork, who: Address, raw: bigint, usdc: Address = BASE_USDC) {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
  await fork.testClient.setStorageAt({ address: usdc, index: slot, value: toHex(raw, { size: 32 }) });
}
