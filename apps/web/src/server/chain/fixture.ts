// In-memory chain reader for `MOCK=1` dev and E2E. State is mutable through the setters, so a
// fake "execute a proposal" can change owners, balances and positions.
import type { Address, AtBlock, ChainId, LoanPosition } from "@/shared/types";
import { tokensOf } from "./config";
import type { AaveMarket, Balances, ChainReader, MarketRead, PositionRead, Prices, TokenBalance } from "./types";

type SafeState = { owners: Address[]; threshold: number; nonce: bigint };

export type FixtureState = {
  blockNumber: bigint;
  safes: Map<string, SafeState>;
  balances: Map<string, TokenBalance[]>;
  positions: Map<string, LoanPosition | null>;
  markets: Map<string, AaveMarket>;
  prices: Record<string, number>;
};

const key = (chainId: ChainId, address: string) => `${chainId}:${address.toLowerCase()}`;
const toRaw = (amount: number, decimals: number) => BigInt(Math.round(amount * 10 ** decimals));

const DEFAULT_PRICES: Record<string, number> = { ETH: 3000, WETH: 3000, wstETH: 3600, USDC: 1 };

function defaultMarket(chainId: ChainId, symbol: string): AaveMarket | undefined {
  const t = tokensOf(chainId).find((x) => x.symbol === symbol && x.address);
  if (!t?.address) return undefined;
  const collateral = symbol !== "USDC";
  return {
    asset: t.address,
    symbol,
    decimals: t.decimals,
    ltv: collateral ? 0.8 : 0,
    liquidationThreshold: collateral ? 0.83 : 0.78,
    supplyCap: 0,
    borrowCap: 0,
    totalDebt: 0,
    availableLiquidity: collateral ? 50_000 : 40_000_000,
    variableBorrowApr: collateral ? 0.0004 : 0.055,
    isActive: true,
    isFrozen: false,
    isPaused: false,
    borrowingEnabled: true,
  };
}

export function createFixtureState(): FixtureState {
  const markets = new Map<string, AaveMarket>();
  for (const chainId of [8453, 84532, 42161] as const) {
    for (const s of ["WETH", "wstETH", "USDC"]) {
      const m = defaultMarket(chainId, s);
      if (m) markets.set(key(chainId, m.asset), m);
    }
  }
  return { blockNumber: 57_172_000n, safes: new Map(), balances: new Map(), positions: new Map(), markets, prices: { ...DEFAULT_PRICES } };
}

export type FixtureReader = ChainReader & {
  state: FixtureState;
  setOwners(chainId: ChainId, safe: Address, owners: Address[], threshold?: number): void;
  /** Mark a Safe as not deployed (owners read returns null). */
  removeSafe(chainId: ChainId, safe: Address): void;
  setNonce(chainId: ChainId, safe: Address, nonce: bigint): void;
  /** Set balances by token symbol in token units (e.g. `{ ETH: 1.5, USDC: 200 }`). Unlisted tokens become 0. */
  setBalances(chainId: ChainId, safe: Address, amounts: Record<string, number>): void;
  setPosition(chainId: ChainId, safe: Address, position: LoanPosition | null): void;
  setMarket(chainId: ChainId, market: AaveMarket): void;
  setPrices(prices: Record<string, number>): void;
  /** Advance the block counter. */
  mine(blocks?: number): bigint;
};

export function createFixtureReader(state: FixtureState = createFixtureState()): FixtureReader {
  const at = <T extends object>(chainId: ChainId, v: T, blockNumber?: bigint): AtBlock<T> => ({ ...v, chainId, blockNumber: blockNumber ?? state.blockNumber, readAt: Date.now() });
  const deployed = (c: ChainId, s: Address) => state.safes.has(key(c, s));
  return {
    state,
    async readBlockNumber() { return state.blockNumber; },
    async readBalances(chainId, safe, blockNumber) {
      const stored = state.balances.get(key(chainId, safe));
      const balances: TokenBalance[] = tokensOf(chainId).filter((t) => t.available).map((t) =>
        stored?.find((b) => b.symbol === t.symbol) ?? { symbol: t.symbol, token: t.address, decimals: t.decimals, amount: 0, raw: 0n });
      return at<Balances>(chainId, { safe, balances }, blockNumber);
    },
    async readAavePosition(chainId, safe, blockNumber) {
      const p = state.positions.get(key(chainId, safe)) ?? null;
      return at<PositionRead>(chainId, { position: p && { ...p, blockNumber: blockNumber ?? state.blockNumber } }, blockNumber);
    },
    async readAaveMarket(chainId, asset, blockNumber) {
      const market = state.markets.get(key(chainId, asset));
      if (!market) throw new Error(`fixture: no market for ${asset}`);
      return at<MarketRead>(chainId, { market }, blockNumber);
    },
    async readPrices(chainId, blockNumber) {
      return at<Prices>(chainId, { prices: { ...state.prices } }, blockNumber);
    },
    async readSafeOwners(c, s) { return deployed(c, s) ? [...state.safes.get(key(c, s))!.owners] : null; },
    async readSafeThreshold(c, s) { return state.safes.get(key(c, s))?.threshold ?? null; },
    async readSafeNonce(c, s) { return state.safes.get(key(c, s))?.nonce ?? null; },
    async isDeployed(c, s) { return deployed(c, s); },

    setOwners(chainId, safe, owners, threshold) {
      const prev = state.safes.get(key(chainId, safe));
      state.safes.set(key(chainId, safe), { owners: [...owners], threshold: threshold ?? (Math.min(prev?.threshold ?? 1, owners.length) || 1), nonce: prev?.nonce ?? 0n });
    },
    removeSafe(chainId, safe) { state.safes.delete(key(chainId, safe)); },
    setNonce(chainId, safe, nonce) {
      const prev = state.safes.get(key(chainId, safe));
      if (prev) prev.nonce = nonce;
    },
    setBalances(chainId, safe, amounts) {
      const rows: TokenBalance[] = [];
      for (const [symbol, amount] of Object.entries(amounts)) {
        const t = tokensOf(chainId).find((x) => x.symbol === symbol);
        if (!t) throw new Error(`fixture: unknown token ${symbol}`);
        rows.push({ symbol, token: t.address, decimals: t.decimals, amount, raw: toRaw(amount, t.decimals) });
      }
      state.balances.set(key(chainId, safe), rows);
    },
    setPosition(chainId, safe, position) { state.positions.set(key(chainId, safe), position); },
    setMarket(chainId, market) { state.markets.set(key(chainId, market.asset), market); },
    setPrices(prices) { Object.assign(state.prices, prices); if (prices.WETH !== undefined && prices.ETH === undefined) state.prices.ETH = prices.WETH; },
    mine(blocks = 1) { state.blockNumber += BigInt(blocks); return state.blockNumber; },
  };
}
