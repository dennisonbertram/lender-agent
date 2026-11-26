// Chain reads. Each function pins one block number and passes it to every call, so all values in
// one result are from the same block (AtBlock).
import type { Address, AtBlock, ChainId, LoanPosition } from "@/shared/types";
import { dataProviderAbi, erc20Abi, oracleAbi, poolAbi } from "./abis";
import { getPublicClient } from "./client";
import { AAVE, erc20Tokens } from "./config";
import type { AaveMarket, Balances, MarketRead, PositionRead, Prices } from "./types";

const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
const RAY = 1e27;

function aaveOf(chainId: ChainId) {
  const a = AAVE[chainId];
  if (!a) throw new Error(`Aave v3 is not configured for chain ${chainId}`);
  return a;
}

export const readBlockNumber = (chainId: ChainId): Promise<bigint> => getPublicClient(chainId).getBlockNumber({ cacheTime: 0 });

async function atBlock<T extends object>(chainId: ChainId, at: bigint | undefined, body: (blockNumber: bigint) => Promise<T>): Promise<AtBlock<T>> {
  const blockNumber = at ?? await readBlockNumber(chainId);
  const value = await body(blockNumber);
  return { ...value, chainId, blockNumber, readAt: Date.now() };
}

export function readBalances(chainId: ChainId, safe: Address, at?: bigint): Promise<AtBlock<Balances>> {
  return atBlock(chainId, at, async (blockNumber) => {
    const client = getPublicClient(chainId);
    const tokens = erc20Tokens(chainId);
    const [eth, ...raws] = await Promise.all([
      client.getBalance({ address: safe, blockNumber }),
      ...tokens.map((t) => client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [safe], blockNumber })),
    ]);
    return {
      safe,
      balances: [
        { symbol: "ETH", token: null, decimals: 18, amount: units(eth, 18), raw: eth },
        ...tokens.map((t, i) => ({ symbol: t.symbol, token: t.address, decimals: t.decimals, amount: units(raws[i]!, t.decimals), raw: raws[i]! })),
      ],
    };
  });
}

export function readPrices(chainId: ChainId, at?: bigint): Promise<AtBlock<Prices>> {
  return atBlock(chainId, at, async (blockNumber) => {
    const aave = aaveOf(chainId);
    const tokens = erc20Tokens(chainId);
    const client = getPublicClient(chainId);
    const [raw, unit] = await client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        { address: aave.oracle, abi: oracleAbi, functionName: "getAssetsPrices", args: [tokens.map((t) => t.address)] },
        { address: aave.oracle, abi: oracleAbi, functionName: "BASE_CURRENCY_UNIT" },
      ],
    });
    const prices: Record<string, number> = {};
    tokens.forEach((t, i) => (prices[t.symbol] = Number(raw[i]!) / Number(unit)));
    if (prices.WETH !== undefined) prices.ETH = prices.WETH;
    return { prices };
  });
}

export function readAaveMarket(chainId: ChainId, asset: Address, at?: bigint): Promise<AtBlock<MarketRead>> {
  return atBlock(chainId, at, async (blockNumber) => {
    const aave = aaveOf(chainId);
    const client = getPublicClient(chainId);
    const dp = aave.dataProvider;
    const [cfg, caps, paused, data, tokensOf3, symbol] = await client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        { address: dp, abi: dataProviderAbi, functionName: "getReserveConfigurationData", args: [asset] },
        { address: dp, abi: dataProviderAbi, functionName: "getReserveCaps", args: [asset] },
        { address: dp, abi: dataProviderAbi, functionName: "getPaused", args: [asset] },
        { address: dp, abi: dataProviderAbi, functionName: "getReserveData", args: [asset] },
        { address: dp, abi: dataProviderAbi, functionName: "getReserveTokensAddresses", args: [asset] },
        { address: asset, abi: erc20Abi, functionName: "symbol" },
      ],
    });
    const decimals = Number(cfg[0]);
    const liquidity = await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [tokensOf3[0]], blockNumber });
    const market: AaveMarket = {
      asset,
      symbol,
      decimals,
      ltv: Number(cfg[1]) / 1e4,
      liquidationThreshold: Number(cfg[2]) / 1e4,
      supplyCap: Number(caps[1]),
      borrowCap: Number(caps[0]),
      totalDebt: units(data[3] + data[4], decimals),
      availableLiquidity: units(liquidity, decimals),
      variableBorrowApr: Number(data[6]) / RAY,
      isActive: cfg[8],
      isFrozen: cfg[9],
      isPaused: paused,
      borrowingEnabled: cfg[6],
    };
    return { market };
  });
}

/** The Safe's whole Aave account as one position, or null when it has no collateral and no debt. */
export function readAavePosition(chainId: ChainId, safe: Address, at?: bigint): Promise<AtBlock<PositionRead>> {
  return atBlock(chainId, at, async (blockNumber) => {
    const aave = aaveOf(chainId);
    const client = getPublicClient(chainId);
    const reserves = await client.readContract({ address: aave.dataProvider, abi: dataProviderAbi, functionName: "getAllReservesTokens", blockNumber });
    const assets = reserves.map((r) => r.tokenAddress);
    const [account, prices, unitRaw, userData, decs] = await Promise.all([
      client.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [safe], blockNumber }),
      client.readContract({ address: aave.oracle, abi: oracleAbi, functionName: "getAssetsPrices", args: [assets], blockNumber }),
      client.readContract({ address: aave.oracle, abi: oracleAbi, functionName: "BASE_CURRENCY_UNIT", blockNumber }),
      client.multicall({ allowFailure: false, blockNumber, contracts: assets.map((a) => ({ address: aave.dataProvider, abi: dataProviderAbi, functionName: "getUserReserveData", args: [a, safe] }) as const) }),
      client.multicall({ allowFailure: false, blockNumber, contracts: assets.map((a) => ({ address: a, abi: erc20Abi, functionName: "decimals" }) as const) }),
    ]);
    const unit = Number(unitRaw);
    const collateral: LoanPosition["collateral"] = [];
    const debt: LoanPosition["debt"] = [];
    assets.forEach((token, i) => {
      const u = userData[i]!;
      const decimals = Number(decs[i]!);
      const price = Number(prices[i]!) / unit;
      const usdValue = (amount: number) => priceAmount(amount, price);
      const asset = reserves[i]!.symbol;
      const supplied = units(u[0], decimals);
      const owed = units(u[1] + u[2], decimals);
      if (u[0] > 0n) collateral.push({ asset, token, amount: supplied, usd: usdValue(supplied) });
      if (u[1] + u[2] > 0n) debt.push({ asset, token, amount: owed, usd: usdValue(owed) });
    });
    if (collateral.length === 0 && debt.length === 0) return { position: null };
    const hasDebt = account[1] > 0n;
    const position: LoanPosition = {
      chainId,
      safe,
      lender: "aave-v3",
      id: `${chainId}:${safe.toLowerCase()}:aave-v3`,
      collateral,
      debt,
      // Aave returns uint256.max with no debt; Infinity says "no liquidation risk".
      healthFactor: hasDebt ? Number(account[5]) / 1e18 : Number.POSITIVE_INFINITY,
      liquidationThreshold: Number(account[3]) / 1e4,
      ltv: Number(account[4]) / 1e4,
      mixed: collateral.length > 1 || debt.length > 1,
      blockNumber,
    };
    return { position };
  });
}

/** A zero or invalid oracle value means the USD value is unknown, never zero. */
export function priceAmount(amount: number, price: number): number | null {
  return Number.isFinite(price) && price > 0 ? amount * price : null;
}
