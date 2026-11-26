// Shared types for the server, the worker and the client. One owner: the coordinator.
// The domain library keeps its own types in `@/lib/types`; these describe real chain data.
import type { Network } from "@/lib/types";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Networks the app supports in M1 (D-16): Base mainnet, and Base Sepolia for live Safe checks. */
export const CHAIN_IDS = { base: 8453, baseSepolia: 84532, arbitrum: 42161 } as const;
export type ChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

/** Domain-library network id for each chain id. Base Sepolia shows as "base" in copy. */
export const NETWORK_OF: Record<ChainId, Network> = { 8453: "base", 84532: "base", 42161: "arbitrum" };
/** Display name of each chain. */
export const CHAIN_NAME: Record<ChainId, string> = { 8453: "Base", 84532: "Base Sepolia", 42161: "Arbitrum" };
/** Safe{Wallet} address prefix (EIP-3770) per chain. */
export const SAFE_PREFIX: Record<ChainId, string> = { 8453: "base", 84532: "basesep", 42161: "arb1" };

export const isChainId = (n: number): n is ChainId => n === 8453 || n === 84532 || n === 42161;

/** The unit of authorization (architecture section 2, rule 8). */
export type SafeRef = { chainId: ChainId; address: Address };

/** A value read from chain names the block it was read at (BP-03). */
export type AtBlock<T> = T & { chainId: ChainId; blockNumber: bigint; readAt: number };

/** Original setup data of a Safe (M0-5). Never recompute the address from current owners. */
export type SafeSetup = {
  version: "1.4.1";
  singleton: Address; // SafeL2 1.4.1
  factory: Address;
  fallbackHandler: Address;
  saltNonce: string;
  owners: Address[];
  threshold: number;
  /** Networks explicitly selected during the original in-app setup; metadata only, never part of deployment calldata. */
  createdChainIds?: number[];
};

/** Proposal stages. 0 draft, 1 in queue, 2 partly signed, 3 executed. Negative = stopped. */
export type ProposalStage =
  | "draft"
  | "sending"
  | "queued" // stage 1 or 2: read confirmations for "n of m signed"
  | "executed"
  | "failed" // execution reverted
  | "rejected"
  | "replaced"
  | "stopped" // agent removed
  | "stale" // out of date
  | "not_sent"; // the service refused the proposal

export type Actor = "Agent" | "Agent (reserve)" | "You" | "Co-signer";
export type ActivityKind = "read" | "proposed" | "status" | "signed" | "reserve";

/** One Safe transaction as the Safe contract hashes it. Immutable once stored. */
export type SafeTx = {
  to: Address;
  value: string; // decimal string, wei
  data: Hex;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: string;
};

/** A loan as one position unit (architecture section 7), read from chain. */
export type LoanPosition = {
  chainId: ChainId;
  safe: Address;
  lender: "aave-v3" | "compound-v3" | "morpho-blue";
  /** Stable id: `${chainId}:${safe}:${lender}`. */
  id: string;
  collateral: { asset: string; token: Address; amount: number; usd: number | null }[];
  debt: { asset: string; token: Address; amount: number; usd: number | null }[];
  healthFactor: number; // from the lender, 18 decimals converted; Infinity when there is no debt
  liquidationThreshold: number; // weighted, 0..1
  ltv: number;
  /** True when more than one collateral or debt asset: hide the liquidation-price line (D-05). */
  mixed: boolean;
  blockNumber: bigint;
};
