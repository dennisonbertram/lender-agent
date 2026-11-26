// Chain configuration: viem chain, RPC, Aave v3 addresses, M1 token list and the batch allowlist.
// Aave addresses on Base were verified on the fork at block 57,172,000 (Pool.ADDRESSES_PROVIDER,
// provider.getPriceOracle, provider.getPoolDataProvider, dataProvider.getAllReservesTokens).
import { arbitrum, base, baseSepolia } from "viem/chains";
import type { Chain } from "viem";
import type { Address, ChainId } from "@/shared/types";

export const VIEM_CHAINS: Record<ChainId, Chain> = { 8453: base, 84532: baseSepolia, 42161: arbitrum };

/**
 * RPCs for a chain, in order: `RPC_URL_<chainId>` (one URL or a comma-separated list), else the viem chain's public default.
 * Only configured URLs are used, so which providers we trust is an explicit setting, never a silent default.
 */
export function rpcUrls(chainId: ChainId): string[] {
  const configured = parseRpcUrls(process.env[`RPC_URL_${chainId}`]);
  return configured.length ? configured : [VIEM_CHAINS[chainId].rpcUrls.default.http[0]!];
}

/** Parse an `RPC_URL_<chainId>` value: comma-separated, trimmed, de-duplicated. */
export function parseRpcUrls(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((u) => u.trim()).filter(Boolean))];
}

/** The first RPC for a chain (callers that need a single URL). */
export function rpcUrl(chainId: ChainId): string {
  return rpcUrls(chainId)[0]!;
}

export type AaveAddresses = { pool: Address; addressesProvider: Address; oracle: Address; dataProvider: Address };

/** Aave v3 deployments. Base Sepolia has none configured: M1 only uses it for Safe checks. */
export const AAVE: Partial<Record<ChainId, AaveAddresses>> = {
  8453: {
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    addressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    oracle: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
    dataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
  },
  // Aave v3 Arbitrum, read on a fork: Pool.ADDRESSES_PROVIDER, provider.getPriceOracle, provider.getPoolDataProvider.
  // Its reserves include WETH, wstETH, WBTC and native USDC (0xaf88...; USDC.e is a separate reserve and is not used).
  42161: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    addressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    oracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
    dataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
  },
};

export const MULTISEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

export type TokenSymbol = "ETH" | "WETH" | "wstETH" | "USDC" | "WBTC";
export type TokenInfo = {
  symbol: TokenSymbol;
  /** null for native ETH. */
  address: Address | null;
  decimals: number;
  /** False when the token has no Aave v3 reserve on this chain (WBTC on Base). */
  available: boolean;
};

const BASE_TOKENS: TokenInfo[] = [
  { symbol: "ETH", address: null, decimals: 18, available: true },
  { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, available: true },
  { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18, available: true },
  { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, available: true },
  // Aave v3 Base lists cbBTC, tBTC and LBTC but no WBTC. Not substituted.
  { symbol: "WBTC", address: null, decimals: 8, available: false },
];

const ARBITRUM_TOKENS: TokenInfo[] = [
  { symbol: "ETH", address: null, decimals: 18, available: true },
  { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, available: true },
  { symbol: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529", decimals: 18, available: true },
  { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, available: true },
  { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, available: true },
];

export const TOKENS: Partial<Record<ChainId, TokenInfo[]>> = { 8453: BASE_TOKENS, 42161: ARBITRUM_TOKENS };

export function tokensOf(chainId: ChainId): TokenInfo[] {
  return TOKENS[chainId] ?? [{ symbol: "ETH", address: null, decimals: 18, available: true }];
}

/** Tokens that exist as ERC-20 on the chain and can be read. */
export const erc20Tokens = (chainId: ChainId) => tokensOf(chainId).filter((t) => t.address && t.available) as (TokenInfo & { address: Address })[];

export function tokenBySymbol(chainId: ChainId, symbol: string): TokenInfo | undefined {
  return tokensOf(chainId).find((t) => t.symbol === symbol);
}
export function tokenByAddress(chainId: ChainId, address: string): TokenInfo | undefined {
  return tokensOf(chainId).find((t) => t.address?.toLowerCase() === address.toLowerCase());
}

/** Contracts the batch builder may target (lowercased). The M1 allowlist source. */
const aaveTargets = (chainId: ChainId) =>
  [AAVE[chainId]!.pool, MULTISEND_CALL_ONLY, ...erc20Tokens(chainId).map((t) => t.address)].map((a) => a.toLowerCase() as Address);

export const ALLOWLIST: Record<ChainId, Address[]> = {
  8453: aaveTargets(8453),
  42161: aaveTargets(42161),
  84532: [MULTISEND_CALL_ONLY.toLowerCase() as Address],
};
