import type { Address, AtBlock, ChainId, LoanPosition } from "@/shared/types";

export type TokenBalance = { symbol: string; token: Address | null; decimals: number; amount: number; raw: bigint };
export type Balances = { safe: Address; balances: TokenBalance[] };

export type AaveMarket = {
  asset: Address;
  symbol: string;
  decimals: number;
  ltv: number; // 0..1
  liquidationThreshold: number; // 0..1
  supplyCap: number; // token units, 0 = no cap
  borrowCap: number; // token units, 0 = no cap
  totalDebt: number; // reserve-wide variable + stable debt, token units
  availableLiquidity: number; // token units
  variableBorrowApr: number; // 0..1
  isActive: boolean;
  isFrozen: boolean;
  isPaused: boolean;
  borrowingEnabled: boolean;
};

export type Prices = { prices: Record<string, number> }; // USD per token, keyed by symbol (ETH = WETH)

export type PositionRead = { position: LoanPosition | null };
export type MarketRead = { market: AaveMarket };

/** Everything the server and worker read from chain. Every read names its block. */
export interface ChainReader {
  /** The latest block: a comparison reads this once, then passes it as `blockNumber` to every read (BP-33). */
  readBlockNumber(chainId: ChainId): Promise<bigint>;
  /** Each read takes an optional `blockNumber` to read at; without it the read pins the latest block. */
  readBalances(chainId: ChainId, safe: Address, blockNumber?: bigint): Promise<AtBlock<Balances>>;
  readAavePosition(chainId: ChainId, safe: Address, blockNumber?: bigint): Promise<AtBlock<PositionRead>>;
  readAaveMarket(chainId: ChainId, asset: Address, blockNumber?: bigint): Promise<AtBlock<MarketRead>>;
  readPrices(chainId: ChainId, blockNumber?: bigint): Promise<AtBlock<Prices>>;
  readSafeOwners(chainId: ChainId, safe: Address): Promise<Address[] | null>;
  readSafeThreshold(chainId: ChainId, safe: Address): Promise<number | null>;
  readSafeNonce(chainId: ChainId, safe: Address): Promise<bigint | null>;
  isDeployed(chainId: ChainId, safe: Address): Promise<boolean>;
}
