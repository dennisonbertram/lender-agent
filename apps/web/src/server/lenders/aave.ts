// Aave v3 as the first adapter. The builders are the M1 ones in aave/build.ts, unchanged; this wraps them
// in the shared shape and adds what the shape needs (borrow, withdraw, close, market and position mapping).
import { encodeFunctionData } from "viem";
import { erc20Abi, dataProviderAbi, poolAbi } from "@/server/chain/abis";
import { getPublicClient } from "@/server/chain/client";
import { AAVE } from "@/server/chain/config";
import { readAaveMarket, readAavePosition, readPrices } from "@/server/chain/reads";
import { buildOpen as aaveOpen, buildRepay as aaveRepay, buildSupplyCollateral, combine, VARIABLE_RATE, VENUE_NAME } from "@/server/aave/build";
import { unitsDown, unitsUp } from "@/server/aave/units";
import { fmt } from "@/lib/format";
import type { ChainId } from "@/shared/types";
import { assertOffered } from "./allowlist";
import { approveStep, assertClosable, assertCollateralInput, call, collateralToken, join, token, withInterestMargin } from "./common";
import type { AdapterMarket, AdapterPosition, Built, LenderAdapter, MarketRef } from "./types";

const pool = (chainId: ChainId) => {
  const a = AAVE[chainId];
  if (!a) throw new Error(`Aave v3 is not configured for chain ${chainId}`);
  return a.pool;
};
const MAX = 2n ** 256n - 1n;

export const aaveAdapter: LenderAdapter = {
  id: "aave-v3",
  name: VENUE_NAME,

  // Same sentence as the explain copy (blocks/explain.ts); a test keeps the two equal.
  liquidationSentence: () => `${VENUE_NAME} can sell only part of your collateral, enough to repay part of the loan. You keep the rest.`,

  async readPosition(ref, safe, at): Promise<AdapterPosition | null> {
    const { position: p } = await readAavePosition(ref.chainId, safe, at);
    if (!p) return null;
    const own = collateralToken(ref.chainId, ref.collateral).address!.toLowerCase();
    const usdc = token(ref.chainId, "USDC").address!.toLowerCase();
    const hasDebt = p.debt.length > 0;
    return {
      lender: "aave-v3", chainId: ref.chainId, safe, marketId: ref.marketId,
      collateral: p.collateral, debt: p.debt,
      health: hasDebt && Number.isFinite(p.healthFactor) ? p.healthFactor : null,
      liquidatable: hasDebt && p.healthFactor < 1,
      liquidationThreshold: p.liquidationThreshold,
      mixed: p.collateral.some((c) => c.token.toLowerCase() !== own) || p.debt.some((d) => d.token.toLowerCase() !== usdc),
      blockNumber: p.blockNumber,
    };
  },

  async readMarket(ref, at): Promise<AdapterMarket> {
    const coll = collateralToken(ref.chainId, ref.collateral).address!;
    const usdc = token(ref.chainId, "USDC").address!;
    const [c, u, prices] = await Promise.all([readAaveMarket(ref.chainId, coll, at), readAaveMarket(ref.chainId, usdc, at), readPrices(ref.chainId, at)]);
    const supplied = await getPublicClient(ref.chainId).readContract({ address: AAVE[ref.chainId]!.dataProvider, abi: dataProviderAbi, functionName: "getReserveData", args: [coll], blockNumber: c.blockNumber });
    const cm = c.market, um = u.market;
    const reason = !um.isActive || um.isPaused ? "USDC is paused on Aave" : um.isFrozen ? "USDC is frozen on Aave" : !um.borrowingEnabled ? "Borrowing USDC is off on Aave"
      : !cm.isActive || cm.isPaused || cm.isFrozen ? `${ref.collateral} is not open for new loans on Aave` : cm.ltv <= 0 ? `${ref.collateral} cannot back a loan on Aave` : undefined;
    return {
      ref, name: VENUE_NAME,
      collateralPriceUsd: prices.prices[ref.collateral] ?? 0,
      ltv: cm.ltv, liquidationThreshold: cm.liquidationThreshold,
      borrowApr: um.variableBorrowApr,
      availableLiquidity: um.availableLiquidity,
      borrowCapLeft: um.borrowCap > 0 ? Math.max(0, um.borrowCap - um.totalDebt) : null,
      collateralSupplyCapLeft: cm.supplyCap > 0 ? Math.max(0, cm.supplyCap - Number(supplied[2]) / 10 ** cm.decimals) : null,
      minBorrow: 0,
      borrowable: reason === undefined, notBorrowableReason: reason,
      blockNumber: c.blockNumber > u.blockNumber ? c.blockNumber : u.blockNumber,
    };
  },

  buildSupply(ref, safe, asset, amount) {
    assertCollateralInput(ref, asset);
    return buildSupplyCollateral({ chainId: ref.chainId, safe, asset, amount });
  },

  buildBorrow(ref, safe, amount) {
    assertOffered(ref);
    const usdc = token(ref.chainId, "USDC");
    const raw = unitsDown(amount, usdc.decimals);
    if (raw === 0n) throw new Error("borrow amount rounds to zero");
    return {
      calls: [call(pool(ref.chainId), encodeFunctionData({ abi: poolAbi, functionName: "borrow", args: [usdc.address!, raw, VARIABLE_RATE, 0, safe] }))],
      steps: [`Borrow ${fmt(amount)} USDC`],
    };
  },

  buildRepay: (ref, safe, amount) => aaveRepay({ chainId: ref.chainId, safe, asset: "USDC", amount }),

  buildWithdraw(ref, safe, amount) {
    const t = collateralToken(ref.chainId, ref.collateral);
    const raw = unitsDown(amount, t.decimals);
    if (raw === 0n) throw new Error("withdraw amount rounds to zero");
    return {
      calls: [call(pool(ref.chainId), encodeFunctionData({ abi: poolAbi, functionName: "withdraw", args: [t.address!, raw, safe] }))],
      steps: [`Take ${fmt(amount, 2)} ${ref.collateral} back from ${VENUE_NAME}`],
    };
  },

  buildOpen({ ref, safe, collateral, borrow }) {
    assertOffered(ref);
    assertCollateralInput(ref, collateral.asset);
    return aaveOpen({ chainId: ref.chainId, safe, collateral, borrow: { asset: "USDC", amount: borrow } });
  },

  buildProtect({ ref, safe, addCollateral, repay }) {
    if (!addCollateral && !repay) throw new Error("protect needs collateral to add or debt to repay");
    if (addCollateral) assertCollateralInput(ref, addCollateral.asset);
    return combine(
      addCollateral ? buildSupplyCollateral({ chainId: ref.chainId, safe, asset: addCollateral.asset, amount: addCollateral.amount }) : { calls: [], steps: [] },
      repay ? aaveRepay({ chainId: ref.chainId, safe, asset: "USDC", amount: repay }) : { calls: [], steps: [] },
    );
  },

  async buildClose({ ref, safe }): Promise<Built> {
    const p = await this.readPosition(ref, safe);
    if (!p) throw new Error("nothing to close: the Safe has no position here");
    assertClosable(p, VENUE_NAME);
    const usdc = token(ref.chainId, "USDC");
    const coll = collateralToken(ref.chainId, ref.collateral);
    const debtRaw = unitsUp(p.debt.find((d) => d.token.toLowerCase() === usdc.address!.toLowerCase())?.amount ?? 0, usdc.decimals);
    const parts: Built[] = [];
    if (debtRaw > 0n) {
      const allow = withInterestMargin(debtRaw);
      parts.push({
        calls: [
          call(usdc.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool(ref.chainId), allow] })),
          // The maximum value repays exactly what is owed, interest to the block included (allowed when repaying one's own debt).
          call(pool(ref.chainId), encodeFunctionData({ abi: poolAbi, functionName: "repay", args: [usdc.address!, MAX, VARIABLE_RATE, safe] })),
        ],
        steps: [approveStep(VENUE_NAME, Number(allow) / 10 ** usdc.decimals, "USDC"), `Repay all USDC debt on ${VENUE_NAME}`],
      });
    }
    parts.push({
      calls: [call(pool(ref.chainId), encodeFunctionData({ abi: poolAbi, functionName: "withdraw", args: [coll.address!, MAX, safe] }))],
      steps: [`Take all ${ref.collateral} back from ${VENUE_NAME}`],
    });
    return join(...parts);
  },
};
