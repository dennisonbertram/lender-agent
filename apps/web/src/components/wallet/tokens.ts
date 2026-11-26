// What the owner can send to a Safe from a connected wallet, on Base. Mirrors BASE_TOKENS in
// src/server/chain/config.ts (server code is not imported on the client); tokens.test.ts keeps them equal.
import { parseEther, type Address } from "viem";

export const SEND_CHAIN_ID = 8453;
export const SEND_CHAIN_NAME = "Base";
export const EXPLORER_TX = "https://basescan.org/tx/";

export type SendChain = { id: number; name: string; explorerName: string; explorerTx: string; assets: SendAsset[] };

export type SendAsset = { symbol: string; address: Address | null; decimals: number };

export const SEND_ASSETS: SendAsset[] = [
  { symbol: "ETH", address: null, decimals: 18 },
  { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
  { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
];

export const ARBITRUM_SEND_ASSETS: SendAsset[] = [
  { symbol: "ETH", address: null, decimals: 18 },
  { symbol: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529", decimals: 18 },
  { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
];

/** The networks a wallet send is offered on. A Safe's address exists on every network, but only a network where the Safe is deployed and owned by the user can spend what lands there. */
export const SEND_CHAINS: SendChain[] = [
  { id: 8453, name: "Base", explorerName: "Basescan", explorerTx: EXPLORER_TX, assets: SEND_ASSETS },
  { id: 42161, name: "Arbitrum", explorerName: "Arbiscan", explorerTx: "https://arbiscan.io/tx/", assets: ARBITRUM_SEND_ASSETS },
];

/** The send networks among the Safe's owned, served chain ids (in SEND_CHAINS order). */
export const sendChainsFor = (ownedChainIds: readonly number[]): SendChain[] => SEND_CHAINS.filter((c) => ownedChainIds.includes(c.id));

/** ETH kept in the wallet when sending "Max", so it can still pay for gas. */
export const ETH_GAS_RESERVE = parseEther("0.0005");
export const ETH_GAS_RESERVE_TEXT = "0.0005";

/** The assets of the Add funds card that can be sent from a wallet (the card's own list, in its order). */
export const sendAssetsFor = (cardAssets?: string[], chainAssets: SendAsset[] = SEND_ASSETS): SendAsset[] =>
  cardAssets?.length ? cardAssets.flatMap((s) => chainAssets.filter((a) => a.symbol === s)) : chainAssets.filter((a) => a.symbol === "ETH" || a.symbol === "wstETH");
