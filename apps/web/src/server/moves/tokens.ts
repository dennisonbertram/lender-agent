// The collateral assets a move can carry, as the aggregator names them on each network. Native ETH is the zero address.
import type { Asset } from "@/lib/types";
import type { Address } from "@/shared/types";
import { NATIVE, type MoveChain } from "./types";

export type MoveToken = { address: Address; decimals: number };

const ADDR: Partial<Record<Asset, Partial<Record<MoveChain, Address>>>> = {
  wstETH: {
    1: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    8453: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
    42161: "0x5979D7b546E38E414F7E9822514be443A4800529",
    10: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb",
  },
  WBTC: {
    1: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    42161: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    10: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    137: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  },
};
const DECIMALS: Record<Asset, number> = { ETH: 18, wstETH: 18, WBTC: 8 };
/** Chains where the native token is ETH. Polygon and Gnosis have other native tokens: ETH there is a wrapped token we do not list. */
const ETH_NATIVE = new Set<MoveChain>([1, 8453, 42161, 10]);

/** Native (Circle-issued) USDC on the networks where CCTP burns and mints it — the only token a Polymer call can carry. */
export const USDC: Partial<Record<MoveChain, Address>> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

/** The token the aggregator is asked to move, or null when we do not know it on that network (no move offered). */
export function moveToken(asset: Asset, chain: MoveChain): MoveToken | null {
  if (asset === "ETH") return ETH_NATIVE.has(chain) ? { address: NATIVE, decimals: 18 } : null;
  const address = ADDR[asset]?.[chain];
  return address ? { address, decimals: DECIMALS[asset] } : null;
}

/** Whole units of the asset to raw token units, rounded to the cent of a unit (plans are rounded up to 0.01). */
export const toRaw = (units: number, decimals: number): bigint => BigInt(Math.round(units * 100)) * 10n ** BigInt(decimals - 2);
export const fromRaw = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;
