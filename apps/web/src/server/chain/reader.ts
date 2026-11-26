import { readBlockNumber, readAaveMarket, readAavePosition, readBalances, readPrices } from "./reads";
import { isDeployed, readSafeNonce, readSafeOwners, readSafeThreshold } from "./safe";
import type { ChainReader } from "./types";

export type { ChainReader } from "./types";

/** The real reader: viem over RPC. */
export function createViemReader(): ChainReader {
  return { readBlockNumber, readBalances, readAavePosition, readAaveMarket, readPrices, readSafeOwners, readSafeThreshold, readSafeNonce, isDeployed };
}
