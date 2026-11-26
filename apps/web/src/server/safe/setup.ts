// Safe setup data and CREATE2 address prediction (M0-5). Always from the stored original setup.
import { encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, concatHex, encodePacked, type Hex } from "viem";
import type { Address, SafeSetup } from "@/shared/types";
import {
  COMPATIBILITY_FALLBACK_HANDLER,
  SAFE_L2_SINGLETON,
  SAFE_PROXY_FACTORY,
  SAFE_VERSION,
  ZERO_ADDRESS,
} from "./constants";

export const safeSetupAbi = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
] as const;

export const proxyFactoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "function",
    name: "proxyCreationCode",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "bytes" }],
  },
] as const;

/** A new setup with the pinned contracts. `saltNonce` is a decimal string. */
export function newSafeSetup(p: { owners: Address[]; threshold: number; saltNonce: string }): SafeSetup {
  return {
    version: SAFE_VERSION,
    singleton: SAFE_L2_SINGLETON,
    factory: SAFE_PROXY_FACTORY,
    fallbackHandler: COMPATIBILITY_FALLBACK_HANDLER,
    saltNonce: p.saltNonce,
    owners: p.owners,
    threshold: p.threshold,
  };
}

/** The salt nonce rule from M0-5: uint256(keccak256("lender-agent/safe/v1/<creator>/<index>")). */
export function deriveSaltNonce(creator: Address, index: number): string {
  return BigInt(keccak256(encodePacked(["string"], [`lender-agent/safe/v1/${creator}/${index}`]))).toString();
}

/** Initializer passed to `createProxyWithNonce`: `setup(...)` with no module setup and no payment. */
export function setupCalldata(setup: SafeSetup): Hex {
  return encodeFunctionData({
    abi: safeSetupAbi,
    functionName: "setup",
    args: [setup.owners, BigInt(setup.threshold), ZERO_ADDRESS, "0x", setup.fallbackHandler, ZERO_ADDRESS, 0n, ZERO_ADDRESS],
  });
}

/** `createProxyWithNonce(singleton, initializer, saltNonce)` calldata: any account can send it. */
export function deploymentCalldata(setup: SafeSetup): Hex {
  return encodeFunctionData({
    abi: proxyFactoryAbi,
    functionName: "createProxyWithNonce",
    args: [setup.singleton, setupCalldata(setup), BigInt(setup.saltNonce)],
  });
}

/**
 * SafeProxyFactory 1.4.1 proxy creation code (constant). Deployment bytecode is
 * proxyCreationCode() (read from the factory on Base, checked in the fork test) ++ uint256(singleton); salt = keccak256(keccak256(initializer) ++ saltNonce).
 */
export const PROXY_CREATION_CODE: Hex =
  "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";

/**
 * The canonical SafeProxy runtime code: what PROXY_CREATION_CODE deploys (171 bytes it codecopies at offset
 * 0x119, asserted in the chain tests). The same bytes at every Safe proxy address on every chain. A contract
 * whose code equals this holds its singleton in storage slot 0 — `masterCopy()` answers it directly — and
 * delegate-calls it for everything else, so the singleton decides what `getOwners` means; bytecode alone does
 * not prove a Safe (a proxy can sit on a hostile singleton), identity needs both halves.
 */
export const SAFE_PROXY_RUNTIME: Hex =
  "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";

/**
 * The proxy runtime's executable portion (118 bytes, ending at the `fe` before the metadata): what the
 * EVM actually runs. Every audited Safe 1.x proxy carries exactly these bytes — the 1.3.0 and 1.4.1
 * runtimes differ only in the CBOR metadata tail the compiler appends (the IPFS hash of the sources).
 */
export const SAFE_PROXY_EXECUTABLE: Hex =
  "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fe";

/**
 * The deployed code minus its Solidity metadata tail, when it carries one. The compiler's auxdata is the
 * last section: its final two bytes are its own length, and it begins with a small CBOR map (the "ipfs" or
 * "bzzr" and "solc" keys). Anything not shaped exactly like that is code, not metadata, and stays.
 */
const executableOf = (code: Hex): Hex => {
  const b = code.slice(2);
  const n = parseInt(b.slice(-4), 16);
  const start = b.length - 4 - n * 2; // where the auxdata begins, in hex chars
  return n >= 40 && start > 0 && /^a[123]/.test(b.slice(start, start + 2)) ? (`0x${b.slice(0, start)}` as Hex) : code;
};

/**
 * Is `code` an audited Safe proxy? The executable portion must equal the canonical bytes exactly — a
 * different compiler build's metadata is the only allowed difference. Bytes appended that are not a
 * metadata tail, a missing byte, or one changed instruction all fail: there is no prefix matching.
 */
export const isSafeProxyCode = (code: Hex): boolean => executableOf(code).toLowerCase() === SAFE_PROXY_EXECUTABLE;

export function predictSafeAddress(setup: SafeSetup): Address {
  const salt = keccak256(concatHex([keccak256(setupCalldata(setup)), encodeAbiParameters([{ type: "uint256" }], [BigInt(setup.saltNonce)])]));
  const bytecode = concatHex([PROXY_CREATION_CODE, encodeAbiParameters([{ type: "uint256" }], [BigInt(setup.singleton)])]);
  return getAddress(getContractAddress({ opcode: "CREATE2", from: setup.factory, salt, bytecode }));
}
