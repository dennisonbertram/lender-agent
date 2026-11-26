import { holdingRows } from "@/lib/block-helpers";
import type { Safe } from "@/lib/types";
import { M1_NETWORKS, borrowLimitFor } from "@/server/market-inputs";
import type { HoldingRowData } from "@/components/blocks/HoldingsBlock";
import { readBlockData, type BlockCtx, type Stamp } from "./block-inputs";

export type HoldingsResponse = { rows: HoldingRowData[] } & Stamp;

export async function holdingsFor(ctx: BlockCtx): Promise<HoldingsResponse> {
  const d = await readBlockData(ctx);
  const rows: HoldingRowData[] = [];
  for (const i of d.inputs) {
    const balances: Safe["balances"] = { [i.network]: { ...i.balances } };
    const prices = i.prices;
    // `max` is the one borrow limit for this asset (same lender rules and prices as the greeting).
    rows.push(...holdingRows(balances, prices, M1_NETWORKS, i.venues).map((r) => ({ ...r, max: borrowLimitFor(i, r.asset).max })));
    // WETH is listed on its own (ETH oracle price) but not planned with, so it can borrow nothing.
    if (i.weth > 0) rows.push({ network: i.network, asset: "WETH", amount: i.weth, value: i.weth * prices.ETH, max: 0 });
  }
  return { rows, blockNumber: d.blockNumber, readAt: d.readAt };
}
