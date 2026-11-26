"use client";
import { erc20Abi, type Address } from "viem";
import { useBalance, useReadContracts } from "wagmi";
import { SEND_CHAIN_ID, type SendAsset } from "./tokens";

/** The connected wallet's balances on this network for these assets, by symbol (undefined while loading). */
export function useWalletBalances(owner: Address | undefined, assets: SendAsset[], chainId: number = SEND_CHAIN_ID): Record<string, bigint | undefined> {
  const eth = useBalance({ address: owner, chainId, query: { enabled: !!owner } });
  const tokens = assets.filter((a) => a.address);
  const reads = useReadContracts({
    contracts: tokens.map((t) => ({ address: t.address!, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner!] as const, chainId })),
    query: { enabled: !!owner && tokens.length > 0 },
  });
  const out: Record<string, bigint | undefined> = {};
  for (const a of assets) {
    if (!a.address) out[a.symbol] = eth.data?.value;
    else {
      const r = reads.data?.[tokens.indexOf(a)];
      out[a.symbol] = r?.status === "success" ? (r.result as bigint) : undefined;
    }
  }
  return out;
}
