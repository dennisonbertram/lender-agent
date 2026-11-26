// The default `world` of the moves deps (BP-36): the Safe's holdings, prices, lenders and loans on every served network
// (SERVED_CHAIN_IDS: Base and Arbitrum), read at one block per network through the real chain reader and lender adapters.
import { eq } from "drizzle-orm";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import type { Amounts, Loan, Safe, Venue } from "@/lib/types";
import { safeNetworks, safes } from "@/server/db/schema";
import { liveInputs, type LiveInputs } from "@/server/market-inputs";
import { shortAddress } from "@/lib/address";
import { isChainId, NETWORK_OF, type ChainId } from "@/shared/types";
import type { MoveDeps } from "./deps";

export const servedChains = (): ChainId[] => SERVED_CHAIN_IDS.filter(isChainId);

export const defaultWorld: NonNullable<MoveDeps["world"]> = async ({ db, services, safeId, safeAddress }) => {
  const rows = await db.select().from(safeNetworks).where(eq(safeNetworks.safeId, safeId));
  const [safeRow] = await db.select().from(safes).where(eq(safes.id, safeId)).limit(1);
  const chains = servedChains().filter((c) => rows.some((r) => r.chainId === c));
  if (chains.length === 0) return null;
  const read = await Promise.all(chains.map(async (chainId): Promise<LiveInputs | null> => liveInputs(services.reader, chainId, safeAddress, services.lenders).catch(() => null)));
  const inputs = read.filter((i): i is LiveInputs => i !== null);
  if (inputs.length === 0) return null;
  const balances: Safe["balances"] = {};
  const venues: Venue[] = [];
  const loans: Loan[] = [];
  for (const i of inputs) {
    balances[i.network] = i.balances as Amounts;
    for (const l of i.lenders) {
      if (l.venue) venues.push(l.venue);
      if (l.loan) loans.push(l.loan);
    }
  }
  const safe: Safe = {
    id: safeAddress, name: safeRow?.name || shortAddress(safeAddress), address: safeAddress, threshold: "1 of 1",
    agent: rows.some((r) => r.agentAdded),
    networks: rows.filter((r) => isChainId(r.chainId) && chains.includes(r.chainId)).map((r) => ({ id: NETWORK_OF[r.chainId as ChainId], deployed: r.deployed, agent: r.agentAdded })),
    balances,
  };
  const withPrice = inputs.find((i) => i.prices.ETH > 0) ?? inputs[0]!;
  return { safe, prices: withPrice.prices as never, venues, loans };
};
