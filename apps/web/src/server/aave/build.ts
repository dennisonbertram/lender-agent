// Aave v3 batch builders (architecture 7). The model never calls these with raw calldata: they take
// typed amounts and produce the calls, the user-facing step names and the outer Safe transaction.
// Native ETH is wrapped inside the batch (WETH deposit with value) because the Pool takes WETH.
import { encodeFunctionData, getAddress } from "viem";
import { erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { AAVE, tokenBySymbol, type TokenInfo } from "@/server/chain/config";
import { buildSafeTx, type Call } from "@/server/safe/multisend";
import type { Address, ChainId, SafeTx } from "@/shared/types";
import { centDigits, fmt } from "@/lib/format";
import { withInterestMargin } from "@/server/lenders/common";
import { unitsDown, unitsUp } from "./units";

export const VENUE_NAME = "Aave v3";
/** Variable rate (stable is not offered on Aave v3 Base). */
export const VARIABLE_RATE = 2n;

export type CollateralAsset = "ETH" | "WETH" | "wstETH";
export type Built = { calls: Required<Call>[]; steps: string[] };

function aave(chainId: ChainId) {
  const a = AAVE[chainId];
  if (!a) throw new Error(`Aave v3 is not configured for chain ${chainId}`);
  return a;
}

function token(chainId: ChainId, symbol: string): TokenInfo {
  const t = tokenBySymbol(chainId, symbol);
  if (!t || !t.available) throw new Error(`${symbol} is not available on chain ${chainId}`);
  return t;
}

const call = (to: Address, data: `0x${string}`, value = 0n): Required<Call> => ({ to: getAddress(to), value, data });

/** Calls and steps that leave `amount` of `symbol` approved to the Pool and supplied for the Safe. */
function supplySteps(chainId: ChainId, safe: Address, symbol: CollateralAsset, amount: number): Built {
  const pool = aave(chainId).pool;
  const t = token(chainId, symbol === "ETH" ? "WETH" : symbol);
  const raw = unitsUp(amount, t.decimals);
  if (raw === 0n) throw new Error("amount rounds to zero");
  const asset = t.address!;
  const calls: Required<Call>[] = [];
  const steps: string[] = [];
  if (symbol === "ETH") {
    calls.push(call(asset, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), raw));
    steps.push("Wrap ETH");
  }
  calls.push(call(asset, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, raw] })));
  calls.push(call(pool, encodeFunctionData({ abi: poolAbi, functionName: "supply", args: [asset, raw, safe, 0] })));
  steps.push(`Allow ${VENUE_NAME} to use ${fmt(amount, 2)} ${symbol}`, `Lock ${fmt(amount, 2)} ${symbol} in ${VENUE_NAME}`);
  return { calls, steps };
}

function borrowStep(chainId: ChainId, safe: Address, amount: number): Built {
  const t = token(chainId, "USDC");
  const raw = unitsDown(amount, t.decimals);
  if (raw === 0n) throw new Error("borrow amount rounds to zero");
  return {
    calls: [call(aave(chainId).pool, encodeFunctionData({ abi: poolAbi, functionName: "borrow", args: [t.address!, raw, VARIABLE_RATE, 0, safe] }))],
    steps: [`Borrow ${fmt(amount)} USDC`],
  };
}

const join = (...parts: Built[]): Built => ({ calls: parts.flatMap((p) => p.calls), steps: parts.flatMap((p) => p.steps) });

/** Open (or add to) a loan: [wrap ETH], approve the Pool, supply for the Safe, borrow USDC to the Safe. */
export function buildOpen(p: {
  chainId: ChainId;
  safe: Address;
  collateral: { asset: CollateralAsset; amount: number };
  borrow: { asset: "USDC"; amount: number };
}): Built {
  if (p.borrow.asset !== "USDC") throw new Error("M1 borrows USDC only");
  return join(supplySteps(p.chainId, p.safe, p.collateral.asset, p.collateral.amount), borrowStep(p.chainId, p.safe, p.borrow.amount));
}

/** Add collateral to the Safe's account (raises health). */
export function buildSupplyCollateral(p: { chainId: ChainId; safe: Address; asset: CollateralAsset; amount: number }): Built {
  return supplySteps(p.chainId, p.safe, p.asset, p.amount);
}

/** Repay USDC debt of the Safe from the Safe's balance (raises health). Rounds the amount up. */
export function buildRepay(p: { chainId: ChainId; safe: Address; asset: "USDC"; amount: number }): Built {
  const pool = aave(p.chainId).pool;
  const t = token(p.chainId, p.asset);
  const raw = unitsUp(p.amount, t.decimals);
  if (raw === 0n) throw new Error("repay amount rounds to zero");
  // Choose the label precision from the amount rounded to cents. Tiny fractional noise should
  // preserve a whole-dollar label, while a real cent amount such as 200.25 keeps both decimals.
  const shown = fmt(p.amount, centDigits(Math.round(p.amount * 100) / 100));
  return {
    calls: [
      call(t.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, raw] })),
      call(pool, encodeFunctionData({ abi: poolAbi, functionName: "repay", args: [t.address!, raw, VARIABLE_RATE, p.safe] })),
    ],
    steps: [`Allow ${VENUE_NAME} to use ${shown} USDC`, `Repay ${shown} USDC on ${VENUE_NAME}`],
  };
}

/** The longest a close may wait between drafting and execution (owners sign, then the Safe executes). The approval covers interest for this long. */
export const MAX_SIGNING_DELAY_SECONDS = 7 * 24 * 3600;
const YEAR_SECONDS = 365 * 24 * 3600;

/** What a close approves, in raw USDC: the debt, plus interest at `aprPercent` for the maximum signing delay, plus the usual small margin. */
export function closeAllowanceRaw(owedRaw: bigint, aprPercent: number): bigint {
  const ppm = BigInt(Math.ceil(Math.max(0, aprPercent) * 10_000)); // APR as parts per million
  const interest = (owedRaw * ppm * BigInt(MAX_SIGNING_DELAY_SECONDS)) / (1_000_000n * BigInt(YEAR_SECONDS)) + 1n;
  return withInterestMargin(owedRaw) + interest;
}

/** The same amount in USDC units: what the Safe must hold for the close to be drafted (and to stay current). */
export function closeAllowance(chainId: ChainId, debt: number, aprPercent: number): number {
  const d = token(chainId, "USDC").decimals;
  return Number(closeAllowanceRaw(unitsUp(debt, d), aprPercent)) / 10 ** d;
}

/**
 * Close a loan: repay all USDC debt, then take all collateral back to the Safe. `debt` is what the
 * position owed when it was read and `apr` (percent) its borrow rate. The repay is the maximum value,
 * which takes exactly the debt at execution however much interest accrued, so no residual debt can
 * block the withdraw. The approval stays bounded and is reset to zero after the repay: the debt plus interest for the maximum signing
 * delay (`closeAllowanceRaw`); the Safe must hold that much USDC. The withdraw takes the whole aToken
 * balance, which also catches the interest the collateral earned in the meantime; it pays the Safe.
 */
export function buildClose(p: { chainId: ChainId; safe: Address; debt: number; apr: number; collateral: "WETH" | "wstETH" }): Built {
  const pool = aave(p.chainId).pool;
  const usdc = token(p.chainId, "USDC");
  const coll = token(p.chainId, p.collateral);
  const calls: Required<Call>[] = [];
  const steps: string[] = [];
  const owed = unitsUp(p.debt, usdc.decimals);
  if (owed > 0n) {
    const allowance = closeAllowanceRaw(owed, p.apr);
    const shown = fmt(Number(allowance) / 10 ** usdc.decimals);
    calls.push(call(usdc.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, allowance] })));
    calls.push(call(pool, encodeFunctionData({ abi: poolAbi, functionName: "repay", args: [usdc.address!, 2n ** 256n - 1n, VARIABLE_RATE, p.safe] })));
    // The max-repay takes only the debt; the unused part of the approval is closed, not left open.
    calls.push(call(usdc.address!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, 0n] })));
    steps.push(`Allow ${VENUE_NAME} to use up to ${shown} USDC`, `Repay all USDC debt on ${VENUE_NAME}`, `Close the ${VENUE_NAME} allowance`);
  }
  calls.push(call(pool, encodeFunctionData({ abi: poolAbi, functionName: "withdraw", args: [coll.address!, 2n ** 256n - 1n, p.safe] })));
  steps.push(`Withdraw all ${p.collateral} from ${VENUE_NAME}`);
  return { calls, steps };
}

/** Combine two builds (e.g. add collateral and repay in one proposal). */
export const combine = join;

/** The outer Safe transaction: one call is a plain call, several go through MultiSendCallOnly (operation 1). */
export function buildOuterTx(calls: Call[], nonce: bigint | number | string): SafeTx {
  return buildSafeTx(calls, nonce);
}
