// Morpho Blue adapter. A position is one isolated market (a collateral/loan pair with its own oracle and
// liquidation LLTV), named by its id. Health is not exposed on chain: it is computed here with Blue's own
// formulas at one block, and exactly 1 is healthy (liquidation needs borrow capacity below the debt).
import { encodeFunctionData, type Hex } from "viem";
import { erc20Abi } from "@/server/chain/abis";
import { getPublicClient } from "@/server/chain/client";
import { tokenByAddress } from "@/server/chain/config";
import { readPrices } from "@/server/chain/reads";
import { unitsDown, unitsUp } from "@/server/aave/units";
import { centDigits, fmt } from "@/lib/format";
import type { Address, ChainId } from "@/shared/types";
import { morphoAbi, morphoIrmAbi, morphoOracleAbi } from "./abis";
import { assertOffered, MORPHO_BLUE, MORPHO_WETH_USDC_ID } from "./allowlist";
import { closeAllowanceRaw } from "@/server/aave/build";
import { approveStep, assertClosable, assertCollateralInput, call, collateralToken, join, token, tokenMeta, wrapIfEth } from "./common";
import type { AdapterMarket, AdapterPosition, Built, LenderAdapter, MarketRef } from "./types";

export const MORPHO_NAME = "Morpho";
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;
const SECONDS_PER_YEAR = 31_536_000;

type Params = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };
type MarketState = { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint };

/** Market parameters by id. Seeded with the market on the allowlist and the wstETH/USDC one (read on the fork); others are filled by a read. */
const params = new Map<string, Params>([
  [MORPHO_WETH_USDC_ID, { loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", collateralToken: "0x4200000000000000000000000000000000000006", oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4", irm: "0x46415998764C29aB2a25CbeA6254146D50D22687", lltv: 860000000000000000n }],
  ["0x13c42741a359ac4a8aa8287d2be109dcf28344484f91185f9a79bd5a805a55ae", { loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", collateralToken: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", oracle: "0xD7A1abA119a236Fea5BBC5cAC6836465cbe9289A", irm: "0x46415998764C29aB2a25CbeA6254146D50D22687", lltv: 860000000000000000n }],
]);
const key = (id: string) => id.toLowerCase();

function paramsOf(ref: MarketRef): Params {
  const p = params.get(key(ref.marketId));
  if (!p) throw new Error(`Morpho market ${ref.marketId} is not known yet: read it first`);
  return p;
}

async function loadParams(ref: MarketRef, blockNumber?: bigint): Promise<Params> {
  const [loanToken, collateralToken, oracle, irm, lltv] = await getPublicClient(ref.chainId).readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "idToMarketParams", args: [ref.marketId as Hex], blockNumber });
  const p = { loanToken, collateralToken, oracle, irm, lltv };
  params.set(key(ref.marketId), p);
  return p;
}

const mulDivDown = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;
const wMulDown = (a: bigint, b: bigint) => mulDivDown(a, b, WAD);

function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const first = x * n;
  const second = mulDivDown(first, first, 2n * WAD);
  const third = mulDivDown(second, first, 3n * WAD);
  return first + second + third;
}

/** Borrow and supply totals as Blue would have them after accruing interest to `timestamp`. */
function accrued(m: MarketState, rate: bigint, timestamp: bigint): MarketState {
  const dt = timestamp - m.lastUpdate;
  if (dt <= 0n || m.totalBorrowAssets === 0n) return m;
  const interest = wMulDown(m.totalBorrowAssets, wTaylorCompounded(rate, dt));
  const feeAmount = wMulDown(interest, m.fee);
  const feeShares = mulDivDown(feeAmount, m.totalSupplyShares, m.totalSupplyAssets + interest - feeAmount + VIRTUAL_ASSETS) ; // fee shares dilute; only supply side
  return { ...m, totalBorrowAssets: m.totalBorrowAssets + interest, totalSupplyAssets: m.totalSupplyAssets + interest, totalSupplyShares: m.totalSupplyShares + feeShares, lastUpdate: timestamp };
}

async function readState(ref: MarketRef, at?: bigint) {
  const client = getPublicClient(ref.chainId);
  const blockNumber = at ?? await client.getBlockNumber({ cacheTime: 0 });
  const id = ref.marketId as Hex;
  const p = await loadParams(ref, blockNumber);
  const [mkt, block, price] = await Promise.all([
    client.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [id], blockNumber }),
    client.getBlock({ blockNumber }),
    client.readContract({ address: p.oracle, abi: morphoOracleAbi, functionName: "price", blockNumber }),
  ]);
  const raw: MarketState = { totalSupplyAssets: mkt[0], totalSupplyShares: mkt[1], totalBorrowAssets: mkt[2], totalBorrowShares: mkt[3], lastUpdate: mkt[4], fee: mkt[5] };
  const rate = p.irm === "0x0000000000000000000000000000000000000000" || raw.totalBorrowAssets === 0n
    ? 0n
    : await client.readContract({ address: p.irm, abi: morphoIrmAbi, functionName: "borrowRateView", args: [p, raw], blockNumber });
  return { blockNumber, p, price, rate, market: accrued(raw, rate, block.timestamp) };
}

const toAssetsUp = (shares: bigint, m: MarketState) => mulDivUp(shares, m.totalBorrowAssets + VIRTUAL_ASSETS, m.totalBorrowShares + VIRTUAL_SHARES);

/** Dollars per unit of a token at `at`: 1 for USDC, else the price the Aave oracle gives it; null when there is none or it cannot be read. */
async function usdPrice(chainId: ChainId, t: { address: Address; symbol: string }, at?: bigint): Promise<number | null> {
  if (t.address.toLowerCase() === token(chainId, "USDC").address!.toLowerCase()) return 1;
  if (!tokenByAddress(chainId, t.address)) return null;
  try {
    const p = (await readPrices(chainId, at)).prices[t.symbol];
    return p !== undefined && Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export const morphoAdapter: LenderAdapter = {
  id: "morpho-blue",
  name: MORPHO_NAME,

  liquidationSentence: () => `${MORPHO_NAME} can sell only part of your collateral, enough to repay part of the loan. You keep the rest.`,

  async readPosition(ref, safe, at): Promise<AdapterPosition | null> {
    const { blockNumber, p, price, market } = await readState(ref, at);
    const pos = await getPublicClient(ref.chainId).readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "position", args: [ref.marketId as Hex, safe], blockNumber });
    const borrowShares = pos[1], collateral = pos[2];
    if (borrowShares === 0n && collateral === 0n) return null;
    const [coll, loan] = await Promise.all([tokenMeta(ref.chainId, p.collateralToken), tokenMeta(ref.chainId, p.loanToken)]);
    const borrowed = toAssetsUp(borrowShares, market);
    const maxBorrow = wMulDown(mulDivDown(collateral, price, ORACLE_PRICE_SCALE), p.lltv);
    const collAmount = Number(collateral) / 10 ** coll.decimals;
    const debtAmount = Number(borrowed) / 10 ** loan.decimals;
    // USD: the loan token's dollar price is 1 for USDC, else a known price (the Aave oracle's); the market oracle values the
    // collateral in loan tokens. A price that cannot be read leaves usd null: unknown, never a loan-token amount shown as dollars.
    const loanPrice = await usdPrice(ref.chainId, loan, blockNumber);
    const collInLoan = Number(mulDivDown(collateral, price, ORACLE_PRICE_SCALE)) / 10 ** loan.decimals;
    const collUsd = loanPrice !== null ? collInLoan * loanPrice : await usdPrice(ref.chainId, coll, blockNumber).then((cp) => (cp !== null ? collAmount * cp : null));
    const debtUsd = loanPrice !== null ? debtAmount * loanPrice : null;
    return {
      lender: "morpho-blue", chainId: ref.chainId, safe, marketId: ref.marketId,
      collateral: collateral > 0n ? [{ asset: coll.symbol, token: p.collateralToken, amount: collAmount, usd: collUsd }] : [],
      debt: borrowed > 0n ? [{ asset: loan.symbol, token: p.loanToken, amount: debtAmount, usd: debtUsd }] : [],
      health: borrowed > 0n ? Number(maxBorrow) / Number(borrowed) : null,
      liquidatable: borrowed > maxBorrow,
      liquidationThreshold: Number(p.lltv) / 1e18,
      mixed: loan.address.toLowerCase() !== token(ref.chainId, "USDC").address!.toLowerCase(), // a loan in anything but USDC is not the plan's pair
      blockNumber,
    };
  },

  async readMarket(ref, at): Promise<AdapterMarket> {
    const { blockNumber, p, price, rate, market } = await readState(ref, at);
    const [coll, loan] = await Promise.all([tokenMeta(ref.chainId, p.collateralToken), tokenMeta(ref.chainId, p.loanToken)]);
    if (coll.symbol !== ref.collateral) throw new Error(`Morpho market ${ref.marketId} holds ${coll.symbol}, not ${ref.collateral}`);
    const cash = await getPublicClient(ref.chainId).readContract({ address: p.loanToken, abi: erc20Abi, functionName: "balanceOf", args: [MORPHO_BLUE], blockNumber });
    const lendable = market.totalSupplyAssets > market.totalBorrowAssets ? market.totalSupplyAssets - market.totalBorrowAssets : 0n;
    const lltv = Number(p.lltv) / 1e18;
    return {
      ref, name: MORPHO_NAME,
      collateralPriceUsd: (Number(price) / 1e36) * 10 ** (coll.decimals - loan.decimals),
      ltv: lltv, liquidationThreshold: lltv,
      borrowApr: (Number(rate) * SECONDS_PER_YEAR) / 1e18,
      availableLiquidity: Number(lendable < cash ? lendable : cash) / 10 ** loan.decimals,
      borrowCapLeft: null, collateralSupplyCapLeft: null, minBorrow: 0,
      borrowable: true,
      blockNumber,
    };
  },

  buildSupply(ref, safe, asset, amount) {
    const p = paramsOf(ref);
    const t = collateralToken(ref.chainId, asset);
    if (t.address!.toLowerCase() !== p.collateralToken.toLowerCase()) throw new Error(`${asset} is not this market's collateral`);
    const raw = unitsUp(amount, t.decimals);
    if (raw === 0n) throw new Error("amount rounds to zero");
    return join(wrapIfEth(ref.chainId, asset, raw), {
      calls: [
        call(t.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO_BLUE, raw] })),
        call(MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [p, raw, safe, "0x"] })),
      ],
      steps: [approveStep(MORPHO_NAME, amount, asset), `Lock ${fmt(amount, 2)} ${asset} in ${MORPHO_NAME}`],
    });
  },

  buildBorrow(ref, safe, amount) {
    assertOffered(ref);
    const p = paramsOf(ref);
    const raw = unitsDown(amount, token(ref.chainId, "USDC").decimals);
    if (raw === 0n) throw new Error("borrow amount rounds to zero");
    return { calls: [call(MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [p, raw, 0n, safe, safe] }))], steps: [`Borrow ${fmt(amount)} USDC`] };
  },

  buildRepay(ref, safe, amount) {
    const p = paramsOf(ref);
    const usdc = token(ref.chainId, "USDC");
    const raw = unitsUp(amount, usdc.decimals);
    if (raw === 0n) throw new Error("repay amount rounds to zero");
    return {
      calls: [
        call(p.loanToken, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO_BLUE, raw] })),
        // By assets, with no callback data: the form that anyone can send for the Safe.
        call(MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [p, raw, 0n, safe, "0x"] })),
      ],
      steps: [approveStep(MORPHO_NAME, amount, "USDC"), `Repay ${fmt(amount, centDigits(amount))} USDC on ${MORPHO_NAME}`],
    };
  },

  buildWithdraw(ref, safe, amount) {
    const p = paramsOf(ref);
    const t = collateralToken(ref.chainId, ref.collateral);
    const raw = unitsDown(amount, t.decimals);
    if (raw === 0n) throw new Error("withdraw amount rounds to zero");
    return { calls: [call(MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [p, raw, safe, safe] }))], steps: [`Take ${fmt(amount, 2)} ${ref.collateral} back from ${MORPHO_NAME}`] };
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
    const here = await this.readPosition(ref, safe);
    if (!here) throw new Error("nothing to close: the Safe has no position here");
    assertClosable(here, MORPHO_NAME);
    const { blockNumber, p, market } = await readState(ref);
    const usdc = token(ref.chainId, "USDC");
    const pos = await getPublicClient(ref.chainId).readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "position", args: [ref.marketId as Hex, safe], blockNumber });
    const parts: Built[] = [];
    if (pos[1] > 0n) {
      const mkt = await this.readMarket(ref, blockNumber);
      const allow = closeAllowanceRaw(toAssetsUp(pos[1], market), mkt.borrowApr * 100); // interest for the signing deadline, as on Aave
      parts.push({
        calls: [
          call(p.loanToken, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO_BLUE, allow] })),
          // By shares: repays exactly the whole debt, interest to the block included.
          call(MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [p, 0n, pos[1], safe, "0x"] })),
        ],
        steps: [approveStep(MORPHO_NAME, Number(allow) / 10 ** usdc.decimals, "USDC"), `Repay all USDC debt on ${MORPHO_NAME}`],
      });
    }
    if (pos[2] > 0n) {
      parts.push({ calls: [call(MORPHO_BLUE, encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [p, pos[2], safe, safe] }))], steps: [`Take all ${ref.collateral} back from ${MORPHO_NAME}`] });
    }
    return join(...parts);
  },
};
