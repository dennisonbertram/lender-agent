// Test run simulation (D-15, M0-4): one `eth_call` with a state override that puts TestRunHelper's
// runtime code at the Safe's address. The helper runs the batch call by call from the Safe's own
// address (Aave sees the Safe as the caller, as in real execution), then reads
// `getUserAccountData(safe)` in the same call.
//
// What this CANNOT see: the Safe's own `execTransaction` path. Signatures, the Safe nonce, a Guard
// and enabled modules are not exercised, and the code replacement means the Safe's real logic does
// not run. Owners' wallets check signatures; a Guard that blocks the batch would only show up on a
// fork run of the real transaction. Interest is accrued to the latest block's timestamp, so debt and
// health differ slightly (about 1e-8 relative) from a later execution. The Safe's ETH and token
// balances are the real on-chain ones, so a Safe that is short of funds fails here too.
import { decodeFunctionResult, encodeFunctionData, getAddress, type Hex, type PublicClient } from "viem";
import { AAVE } from "@/server/chain/config";
import { readPrices } from "@/server/chain/reads";
import type { Call } from "@/server/safe/multisend";
import type { Address, ChainId } from "@/shared/types";
import { networkFeeUsd } from "./fee";
import { HELPER_RUNTIME_BYTECODE } from "./helper-bytecode";

export const helperAbi = [
  {
    type: "function",
    name: "simulate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [
      {
        name: "r",
        type: "tuple",
        components: [
          { name: "ok", type: "bool" },
          { name: "failedStep", type: "uint256" },
          { name: "revertData", type: "bytes" },
          { name: "totalCollateralBase", type: "uint256" },
          { name: "totalDebtBase", type: "uint256" },
          { name: "healthFactor", type: "uint256" },
          { name: "gasUsed", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/** Gas the Safe's `execTransaction` adds around the batch (M0-4: real 519,330 vs helper 465,703, plus room for more signatures). */
export const EXEC_OVERHEAD_GAS = 65_000n;

export type SimulationResult = {
  ok: boolean;
  /** Zero-based index of the call that reverted, when !ok. */
  failedStep?: number;
  revertData?: Hex;
  /** Aave's health factor after the batch; Infinity when there is no debt; null when the batch failed or the venue is not Aave. */
  healthAfter: number | null;
  /** Aave base currency (USD, 8 decimals) raw values after the batch. */
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  /** Gas of the batch plus a fixed allowance for execTransaction. */
  gasUsed: bigint;
  /** About: gas × current gas price × ETH price (an estimate). */
  feeUsd: number;
};

const MAX_UINT = (1n << 256n) - 1n;

/** Where the helper reads the account after the batch. Aave has `getUserAccountData`; the other lenders have no such call. */
const NO_ACCOUNT_READER = "0x00000000000000000000000000000000000057b0" as const;
/** Runtime code that answers any call with six zero words: "no collateral, no debt" in the shape of `getUserAccountData`. */
const ZERO_ACCOUNT_CODE: Hex = "0x60c05ff3";

export async function simulateBatch(p: {
  client: PublicClient;
  chainId: ChainId;
  safe: Address;
  calls: Call[];
  /**
   * "aave" (default) reads Aave's account after the batch. "generic" (Compound, Morpho) runs the same
   * call-by-call batch from the Safe and reports ok / failedStep / gas; healthAfter is then null and the
   * Aave totals are zero, because the lender's own health is not read here.
   */
  venue?: "aave" | "generic";
}): Promise<SimulationResult> {
  const generic = p.venue === "generic";
  const aave = AAVE[p.chainId];
  if (!generic && !aave) throw new Error(`Aave v3 is not configured for chain ${p.chainId}`);
  const safe = getAddress(p.safe);
  const data = encodeFunctionData({
    abi: helperAbi,
    functionName: "simulate",
    args: [generic ? NO_ACCOUNT_READER : aave!.pool, p.calls.map((c) => getAddress(c.to)), p.calls.map((c) => BigInt(c.value ?? 0)), p.calls.map((c) => c.data ?? "0x")],
  });
  const res = await p.client.call({
    to: safe,
    data,
    account: safe,
    stateOverride: [{ address: safe, code: HELPER_RUNTIME_BYTECODE }, ...(generic ? [{ address: NO_ACCOUNT_READER, code: ZERO_ACCOUNT_CODE }] : [])],
  });
  if (!res.data) throw new Error("test run returned no data");
  const r = decodeFunctionResult({ abi: helperAbi, functionName: "simulate", data: res.data });

  const gasUsed = r.gasUsed + EXEC_OVERHEAD_GAS;
  const [gasPrice, prices] = await Promise.all([p.client.getGasPrice(), readPrices(p.chainId)]);
  const ethUsd = prices.prices.ETH ?? 0;
  const feeUsd = networkFeeUsd(gasUsed, gasPrice, ethUsd);

  const hasDebt = r.totalDebtBase > 0n;
  const healthAfter = !r.ok || generic ? null : !hasDebt || r.healthFactor === MAX_UINT ? Number.POSITIVE_INFINITY : Number(r.healthFactor) / 1e18;
  return {
    ok: r.ok,
    ...(r.ok ? {} : { failedStep: Number(r.failedStep), revertData: r.revertData as Hex }),
    healthAfter,
    totalCollateralBase: r.totalCollateralBase,
    totalDebtBase: r.totalDebtBase,
    gasUsed,
    feeUsd,
  };
}
