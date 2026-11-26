// `MOCK=1` Test run: no chain to call, so decode the batch and compute the result from the fixture
// reader's balances, prices and market, with the same math the lender uses (health = collateral ×
// liquidation threshold ÷ debt). Only for dev and E2E; integration tests use the fork.
import { decodeFunctionData } from "viem";
import { poolAbi, wethAbi } from "@/server/chain/abis";
import { tokenByAddress } from "@/server/chain/config";
import type { ChainReader } from "@/server/chain/types";
import type { Call } from "@/server/safe/multisend";
import type { Address, ChainId } from "@/shared/types";
import { MOCK_GAS_PRICE_WEI, MOCK_TX_GAS, networkFeeUsd } from "./fee";
import type { SimulationResult } from "./simulate";

export function mockSimulate(reader: ChainReader) {
  return async (p: { chainId: ChainId; safe: Address; calls: Required<Call>[] }): Promise<SimulationResult> => {
    const [{ balances }, { prices }, { position }] = await Promise.all([reader.readBalances(p.chainId, p.safe), reader.readPrices(p.chainId), reader.readAavePosition(p.chainId, p.safe)]);
    const held = new Map(balances.map((b) => [b.symbol, b.amount]));
    let collUsd = position?.collateral.reduce((s, c) => s + (c.usd ?? 0), 0) ?? 0;
    let debtUsd = position?.debt.reduce((s, d) => s + (d.usd ?? 0), 0) ?? 0;
    let lt = position?.liquidationThreshold ?? 0;
    const fail = (i: number): SimulationResult => ({ ok: false, failedStep: i, healthAfter: null, totalCollateralBase: 0n, totalDebtBase: 0n, gasUsed: 0n, feeUsd: 0.02 });
    for (const [i, call] of p.calls.entries()) {
      const value = BigInt(call.value ?? 0);
      if (value > 0n) {
        const eth = Number(value) / 1e18;
        if ((held.get("ETH") ?? 0) + 1e-12 < eth) return fail(i);
        held.set("ETH", (held.get("ETH") ?? 0) - eth);
        held.set("WETH", (held.get("WETH") ?? 0) + eth);
        try { decodeFunctionData({ abi: wethAbi, data: call.data }); } catch { return fail(i); }
        continue;
      }
      let decoded;
      try { decoded = decodeFunctionData({ abi: poolAbi, data: call.data }); } catch { continue; } // approve and other token calls
      const token = tokenByAddress(p.chainId, decoded.args[0] as string);
      if (!token) return fail(i);
      const amount = Number(decoded.args[1] as bigint) / 10 ** token.decimals;
      const price = prices[token.symbol] ?? 0;
      if (decoded.functionName === "supply") {
        if ((held.get(token.symbol) ?? 0) + 1e-12 < amount) return fail(i);
        held.set(token.symbol, (held.get(token.symbol) ?? 0) - amount);
        const market = (await reader.readAaveMarket(p.chainId, token.address!)).market;
        lt = collUsd + amount * price > 0 ? (lt * collUsd + market.liquidationThreshold * amount * price) / (collUsd + amount * price) : 0;
        collUsd += amount * price;
      } else if (decoded.functionName === "borrow") {
        const market = (await reader.readAaveMarket(p.chainId, token.address!)).market;
        if (amount > market.availableLiquidity) return fail(i);
        debtUsd += amount * price;
        if (debtUsd > 0 && (collUsd * lt) / debtUsd < 1) return fail(i);
      } else if (decoded.functionName === "repay") {
        // Aave takes at most what is owed: a repay with a margin pays the debt, not the margin.
        const owed = position?.debt.find((d) => d.asset === token.symbol)?.amount ?? 0;
        const paid = Math.min(amount, owed);
        if ((held.get(token.symbol) ?? 0) + 1e-9 < paid) return fail(i);
        held.set(token.symbol, (held.get(token.symbol) ?? 0) - paid);
        debtUsd = Math.max(0, debtUsd - paid * price);
      }
    }
    return {
      ok: true,
      healthAfter: debtUsd > 0 ? (collUsd * lt) / debtUsd : Infinity,
      totalCollateralBase: BigInt(Math.round(collUsd * 1e8)),
      totalDebtBase: BigInt(Math.round(debtUsd * 1e8)),
      gasUsed: MOCK_TX_GAS,
      feeUsd: networkFeeUsd(MOCK_TX_GAS, MOCK_GAS_PRICE_WEI, prices.ETH ?? 0),
    };
  };
}
