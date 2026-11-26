// Shared by the adapters: call and step helpers, and the two pure rules every lender follows.
import { encodeFunctionData, getAddress } from "viem";
import { erc20Abi, wethAbi } from "@/server/chain/abis";
import { getPublicClient } from "@/server/chain/client";
import { tokenBySymbol, type TokenInfo } from "@/server/chain/config";
import type { Call } from "@/server/safe/multisend";
import { fmt } from "@/lib/format";
import type { Address, ChainId } from "@/shared/types";
import type { AdapterMarket, AdapterPosition, Built, CollateralInput, MarketRef } from "./types";

export const call = (to: Address, data: `0x${string}`, value = 0n): Required<Call> => ({ to: getAddress(to), value, data });

export function token(chainId: ChainId, symbol: string): TokenInfo {
  const t = tokenBySymbol(chainId, symbol);
  if (!t || !t.available) throw new Error(`${symbol} is not available on chain ${chainId}`);
  return t;
}

/** The ERC-20 a collateral input is held as: ETH becomes WETH. */
export const collateralToken = (chainId: ChainId, asset: CollateralInput) => token(chainId, asset === "ETH" ? "WETH" : asset);

/** The "Wrap ETH" call and step, when the input is native ETH; otherwise nothing. */
export function wrapIfEth(chainId: ChainId, asset: CollateralInput, raw: bigint): Built {
  if (asset !== "ETH") return { calls: [], steps: [] };
  return { calls: [call(token(chainId, "WETH").address!, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), raw)], steps: ["Wrap ETH"] };
}

export const join = (...parts: Built[]): Built => ({ calls: parts.flatMap((p) => p.calls), steps: parts.flatMap((p) => p.steps) });

export const approveStep = (lender: string, amount: number, symbol: string) => `Allow ${lender} to use ${fmt(amount, 2)} ${symbol}`;

/** Slack for interest that accrues between signing and execution when closing a loan. */
export const withInterestMargin = (raw: bigint) => raw + raw / 1000n + 10n;

export type Feasibility = { ok: true } | { ok: false; reason: string };

/** Whether a borrow of `borrow` USDC can be served now. A plan the market cannot serve is infeasible, never a failing proposal. */
export function canOpen(m: AdapterMarket, borrow: number, collateralAmount = 0): Feasibility {
  if (!m.borrowable) return { ok: false, reason: m.notBorrowableReason ?? "Borrowing is paused here" };
  if (borrow < m.minBorrow) return { ok: false, reason: `Below the minimum borrow of ${fmt(m.minBorrow)} USDC` };
  if (borrow > m.availableLiquidity) return { ok: false, reason: `Not enough liquidity: the market can lend ${fmt(m.availableLiquidity)} USDC now` };
  if (m.borrowCapLeft !== null && borrow > m.borrowCapLeft) return { ok: false, reason: "The borrow cap is reached" };
  if (m.collateralSupplyCapLeft !== null && collateralAmount > m.collateralSupplyCapLeft) return { ok: false, reason: "The supply cap for this collateral is reached" };
  return { ok: true };
}

/** One position unit (architecture 7, D-05): no plan where the account holds anything besides the plan's own pair. */
export function planAvailable(position: AdapterPosition | null): Feasibility {
  if (position?.mixed) return { ok: false, reason: "not available for this Safe yet" };
  return { ok: true };
}

/** Native ETH is wrapped to WETH, so it is an input only for a WETH market; any other collateral must be the market's own. */
export function assertCollateralInput(ref: MarketRef, asset: CollateralInput): void {
  if (asset === ref.collateral || (asset === "ETH" && ref.collateral === "WETH")) return;
  throw new Error(`${asset} is not this market's collateral (${ref.collateral})`);
}

/** Closing builds repay-all and withdraw-all for the plan's own pair only, so an account holding anything else is refused. */
export function assertClosable(p: AdapterPosition, lender: string): void {
  if (p.mixed) throw new Error(`Closing is not available for this Safe yet: its ${lender} account also holds assets or debt beyond the market's own collateral and USDC loan`);
}

export type TokenMeta = { address: Address; symbol: string; decimals: number };
const metaCache = new Map<string, TokenMeta>();

/** Symbol and decimals of any token: the configured ones first, otherwise read from the token itself (for markets that are not offered). */
export async function tokenMeta(chainId: ChainId, address: Address): Promise<TokenMeta> {
  const k = `${chainId}:${address.toLowerCase()}`;
  const hit = metaCache.get(k);
  if (hit) return hit;
  const client = getPublicClient(chainId);
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
  ]);
  const m = { address, symbol, decimals: Number(decimals) };
  metaCache.set(k, m);
  return m;
}
