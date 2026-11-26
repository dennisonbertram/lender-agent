// "Add funds": the Safe address and where it works. The wording is shared with the panel (ADD_FUNDS_TEXT).
import { getAddress } from "viem";
import { ADD_FUNDS_TEXT } from "@/lib/add-funds-text";
import { M1_COLLATERAL } from "@/server/market-inputs";
import { readBlockData, networkIdsOf, type BlockCtx, type Stamp } from "./block-inputs";

export type AddFundsResponse = { address: string; networks: string[]; assets: string[]; text: string } & Stamp;

export async function addFundsFor(ctx: BlockCtx): Promise<AddFundsResponse> {
  const d = await readBlockData(ctx);
  const assets: string[] = M1_COLLATERAL.map((c) => c.asset);
  const text = ADD_FUNDS_TEXT;
  return { address: getAddress(d.address), networks: networkIdsOf(d), assets, text, blockNumber: d.blockNumber, readAt: d.readAt };
}
