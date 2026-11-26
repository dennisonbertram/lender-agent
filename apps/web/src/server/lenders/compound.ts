// Compound v3 (Comet) adapter. A Comet market has one base asset (USDC) and several collaterals; the
// account is the position unit, there is no health factor, and liquidation (absorb) takes the whole account.
import { encodeFunctionData } from "viem";
import { erc20Abi } from "@/server/chain/abis";
import { getPublicClient } from "@/server/chain/client";
import { unitsDown, unitsUp } from "@/server/aave/units";
import { centDigits, fmt } from "@/lib/format";
import type { Address, ChainId } from "@/shared/types";
import { cometAbi } from "./abis";
import { assertOffered } from "./allowlist";
import { closeAllowanceRaw } from "@/server/aave/build";
import { approveStep, assertClosable, assertCollateralInput, call, collateralToken, join, token, tokenMeta, wrapIfEth } from "./common";
import type { AdapterMarket, AdapterPosition, Built, LenderAdapter } from "./types";

export const COMPOUND_NAME = "Compound v3";
const MAX = 2n ** 256n - 1n;
const SECONDS_PER_YEAR = 31_536_000;
const FACTOR = 1e18;
const PRICE = 1e8;

const comet = (marketId: string) => marketId as Address;

/** Collateral bookkeeping of a Comet that an account position needs, all at one block. */
async function readAssets(chainId: ChainId, c: Address, blockNumber: bigint, safe?: Address) {
  const client = getPublicClient(chainId);
  const n = await client.readContract({ address: c, abi: cometAbi, functionName: "numAssets", blockNumber });
  const infos = await client.multicall({ allowFailure: false, blockNumber, contracts: Array.from({ length: n }, (_, i) => ({ address: c, abi: cometAbi, functionName: "getAssetInfo", args: [i] }) as const) });
  const prices = await client.multicall({ allowFailure: false, blockNumber, contracts: infos.map((i) => ({ address: c, abi: cometAbi, functionName: "getPrice", args: [i.priceFeed] }) as const) });
  const balances = safe
    ? await client.multicall({ allowFailure: false, blockNumber, contracts: infos.map((i) => ({ address: c, abi: cometAbi, functionName: "userCollateral", args: [safe, i.asset] }) as const) })
    : [];
  return { infos, prices, balances };
}

export const compoundAdapter: LenderAdapter = {
  id: "compound-v3",
  name: COMPOUND_NAME,

  liquidationSentence: () =>
    `${COMPOUND_NAME} takes the whole account if the loan is liquidated: all of your collateral, not only part of it. Anything left after the debt is paid is credited back to you in USDC.`,

  async readPosition(ref, safe, at): Promise<AdapterPosition | null> {
    const client = getPublicClient(ref.chainId);
    const c = comet(ref.marketId);
    const blockNumber = at ?? await client.getBlockNumber({ cacheTime: 0 });
    const [{ infos, prices, balances }, borrowRaw, supplyRaw, liquidatable, baseFeed, baseAddr] = await Promise.all([
      readAssets(ref.chainId, c, blockNumber, safe),
      client.readContract({ address: c, abi: cometAbi, functionName: "borrowBalanceOf", args: [safe], blockNumber }),
      client.readContract({ address: c, abi: cometAbi, functionName: "balanceOf", args: [safe], blockNumber }),
      client.readContract({ address: c, abi: cometAbi, functionName: "isLiquidatable", args: [safe], blockNumber }),
      client.readContract({ address: c, abi: cometAbi, functionName: "baseTokenPriceFeed", blockNumber }),
      client.readContract({ address: c, abi: cometAbi, functionName: "baseToken", blockNumber }),
    ]);
    // The base asset is whatever this Comet lends (USDC, WETH, ...): read its metadata, never assume 6 decimals.
    const base = await tokenMeta(ref.chainId, baseAddr);
    const symbols = await Promise.all(infos.map((i) => tokenMeta(ref.chainId, i.asset).then((t) => t.symbol)));
    const basePrice = Number(await client.readContract({ address: c, abi: cometAbi, functionName: "getPrice", args: [baseFeed], blockNumber })) / PRICE;
    const own = collateralToken(ref.chainId, ref.collateral).address!.toLowerCase();
    const baseIsUsdc = baseAddr.toLowerCase() === token(ref.chainId, "USDC").address!.toLowerCase();
    const collateral: AdapterPosition["collateral"] = [];
    let capacity = 0; // USD of borrowing that triggers liquidation
    infos.forEach((info, i) => {
      const bal = balances[i]![0];
      if (bal === 0n) return;
      const amount = Number(bal) / Number(info.scale);
      const usd = amount * (Number(prices[i]!) / PRICE);
      collateral.push({ asset: symbols[i]!, token: info.asset, amount, usd });
      capacity += usd * (Number(info.liquidateCollateralFactor) / FACTOR);
    });
    if (collateral.length === 0 && borrowRaw === 0n && supplyRaw === 0n) return null;
    const debtAmount = Number(borrowRaw) / 10 ** base.decimals;
    const debt: AdapterPosition["debt"] = borrowRaw > 0n ? [{ asset: base.symbol, token: base.address, amount: debtAmount, usd: debtAmount * basePrice }] : [];
    const supplyBalance = supplyRaw > 0n; // a USDC supply balance in the market is not the plan's own pair
    return {
      lender: "compound-v3", chainId: ref.chainId, safe, marketId: ref.marketId, collateral, debt,
      health: debt.length ? capacity / (debtAmount * basePrice) : null,
      liquidatable,
      liquidationThreshold: capacity > 0 && collateral.length ? capacity / collateral.reduce((s, x) => s + (x.usd ?? 0), 0) : 0,
      mixed: supplyBalance || !baseIsUsdc || collateral.some((x) => x.token.toLowerCase() !== own),
      blockNumber,
    };
  },

  async readMarket(ref, at): Promise<AdapterMarket> {
    const client = getPublicClient(ref.chainId);
    const c = comet(ref.marketId);
    const coll = collateralToken(ref.chainId, ref.collateral);
    const blockNumber = at ?? await client.getBlockNumber({ cacheTime: 0 });
    const usdc = await tokenMeta(ref.chainId, await client.readContract({ address: c, abi: cometAbi, functionName: "baseToken", blockNumber })); // the market's base asset
    const read = <F extends string>(functionName: F, args?: readonly unknown[]) =>
      client.readContract({ address: c, abi: cometAbi, functionName, args, blockNumber } as never) as Promise<never>;
    const [info, supply, borrow, util, minBorrow, supplyPaused, withdrawPaused, cash] = await Promise.all([
      read("getAssetInfoByAddress", [coll.address]) as Promise<Awaited<ReturnType<typeof readAssets>>["infos"][number]>,
      read("totalSupply") as Promise<bigint>,
      read("totalBorrow") as Promise<bigint>,
      read("getUtilization") as Promise<bigint>,
      read("baseBorrowMin") as Promise<bigint>,
      read("isSupplyPaused") as Promise<boolean>,
      read("isWithdrawPaused") as Promise<boolean>,
      client.readContract({ address: usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [c], blockNumber }),
    ]);
    const [rate, price, totals] = await Promise.all([
      client.readContract({ address: c, abi: cometAbi, functionName: "getBorrowRate", args: [util], blockNumber }),
      client.readContract({ address: c, abi: cometAbi, functionName: "getPrice", args: [info.priceFeed], blockNumber }),
      client.readContract({ address: c, abi: cometAbi, functionName: "totalsCollateral", args: [coll.address!], blockNumber }),
    ]);
    const lendable = supply > borrow ? supply - borrow : 0n;
    const reason = withdrawPaused ? "Borrowing is paused on Compound" : supplyPaused ? "Adding collateral is paused on Compound" : info.borrowCollateralFactor === 0n ? `${ref.collateral} cannot back a loan on Compound` : undefined;
    return {
      ref, name: COMPOUND_NAME,
      collateralPriceUsd: Number(price) / PRICE,
      ltv: Number(info.borrowCollateralFactor) / FACTOR,
      liquidationThreshold: Number(info.liquidateCollateralFactor) / FACTOR,
      borrowApr: (Number(rate) * SECONDS_PER_YEAR) / FACTOR,
      availableLiquidity: Number(lendable < cash ? lendable : cash) / 10 ** usdc.decimals,
      borrowCapLeft: null,
      collateralSupplyCapLeft: info.supplyCap > totals[0] ? Number(info.supplyCap - totals[0]) / Number(info.scale) : 0,
      minBorrow: Number(minBorrow) / 10 ** usdc.decimals,
      borrowable: reason === undefined, notBorrowableReason: reason,
      blockNumber,
    };
  },

  buildSupply(ref, safe, asset, amount) {
    assertCollateralInput(ref, asset);
    const t = collateralToken(ref.chainId, asset);
    const raw = unitsUp(amount, t.decimals);
    if (raw === 0n) throw new Error("amount rounds to zero");
    const c = comet(ref.marketId);
    return join(wrapIfEth(ref.chainId, asset, raw), {
      calls: [
        call(t.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c, raw] })),
        // supplyTo credits the Safe whoever sends it, and needs no approval from the Safe.
        call(c, encodeFunctionData({ abi: cometAbi, functionName: "supplyTo", args: [safe, t.address!, raw] })),
      ],
      steps: [approveStep(COMPOUND_NAME, amount, asset), `Lock ${fmt(amount, 2)} ${asset} in ${COMPOUND_NAME}`],
    });
  },

  buildBorrow(ref, _safe, amount) {
    assertOffered(ref);
    const usdc = token(ref.chainId, "USDC");
    const raw = unitsDown(amount, usdc.decimals);
    if (raw === 0n) throw new Error("borrow amount rounds to zero");
    // Withdrawing the base asset with no supply balance is a borrow, paid to the caller (the Safe).
    return { calls: [call(comet(ref.marketId), encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [usdc.address!, raw] }))], steps: [`Borrow ${fmt(amount)} USDC`] };
  },

  buildRepay(ref, safe, amount) {
    const usdc = token(ref.chainId, "USDC");
    const raw = unitsUp(amount, usdc.decimals);
    if (raw === 0n) throw new Error("repay amount rounds to zero");
    const c = comet(ref.marketId);
    return {
      calls: [
        call(usdc.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c, raw] })),
        // Supplying the base asset to the Safe repays its debt; the Safe's approval is not needed.
        call(c, encodeFunctionData({ abi: cometAbi, functionName: "supplyTo", args: [safe, usdc.address!, raw] })),
      ],
      steps: [approveStep(COMPOUND_NAME, amount, "USDC"), `Repay ${fmt(amount, centDigits(amount))} USDC on ${COMPOUND_NAME}`],
    };
  },

  buildWithdraw(ref, _safe, amount) {
    const t = collateralToken(ref.chainId, ref.collateral);
    const raw = unitsDown(amount, t.decimals);
    if (raw === 0n) throw new Error("withdraw amount rounds to zero");
    return { calls: [call(comet(ref.marketId), encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [t.address!, raw] }))], steps: [`Take ${fmt(amount, 2)} ${ref.collateral} back from ${COMPOUND_NAME}`] };
  },

  buildOpen({ ref, safe, collateral, borrow }) {
    assertOffered(ref);
    assertCollateralInput(ref, collateral.asset);
    return join(this.buildSupply(ref, safe, collateral.asset, collateral.amount), this.buildBorrow(ref, safe, borrow));
  },

  buildProtect({ ref, safe, addCollateral, repay }) {
    if (!addCollateral && !repay) throw new Error("protect needs collateral to add or debt to repay");
    return join(
      addCollateral ? this.buildSupply(ref, safe, addCollateral.asset, addCollateral.amount) : { calls: [], steps: [] },
      repay ? this.buildRepay(ref, safe, repay) : { calls: [], steps: [] },
    );
  },

  async buildClose({ ref, safe }): Promise<Built> {
    const p = await this.readPosition(ref, safe);
    if (!p) throw new Error("nothing to close: the Safe has no position here");
    assertClosable(p, COMPOUND_NAME);
    const usdc = token(ref.chainId, "USDC");
    const coll = collateralToken(ref.chainId, ref.collateral);
    const c = comet(ref.marketId);
    const client = getPublicClient(ref.chainId);
    const [debtRaw, collRaw] = await Promise.all([
      client.readContract({ address: c, abi: cometAbi, functionName: "borrowBalanceOf", args: [safe], blockNumber: p.blockNumber }),
      client.readContract({ address: c, abi: cometAbi, functionName: "userCollateral", args: [safe, coll.address!], blockNumber: p.blockNumber }),
    ]);
    const parts: Built[] = [];
    if (debtRaw > 0n) {
      const market = await this.readMarket(ref, p.blockNumber);
      const allow = closeAllowanceRaw(debtRaw, market.borrowApr * 100); // interest for the signing deadline, as on Aave
      parts.push({
        calls: [
          call(usdc.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c, allow] })),
          // Supplying the maximum value repays exactly the borrow balance at execution.
          call(c, encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [usdc.address!, MAX] })),
        ],
        steps: [approveStep(COMPOUND_NAME, Number(allow) / 10 ** usdc.decimals, "USDC"), `Repay all USDC debt on ${COMPOUND_NAME}`],
      });
    }
    if (collRaw[0] > 0n) {
      parts.push({ calls: [call(c, encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [coll.address!, collRaw[0]] }))], steps: [`Take all ${ref.collateral} back from ${COMPOUND_NAME}`] });
    }
    return join(...parts);
  },
};
