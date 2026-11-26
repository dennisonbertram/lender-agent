// The Test run (BP-13): build the batch, simulate it from the Safe's address, check the invariants,
// and say in the card's words whether it can be sent. The wording matches the mockup's
// `testRunLine` (src/lib/proposals.ts in the mockup); the port in apps/web/src/lib does not carry it yet.
import { usd } from "@/lib/format";
import type { Spec } from "@/lib/proposals";
import type { Asset } from "@/lib/types";
import { getPublicClient } from "@/server/chain/client";
import { readSafeNonce } from "@/server/chain/safe";
import { buildOpen, buildOuterTx, buildRepay, buildSupplyCollateral, combine, type Built, type CollateralAsset } from "@/server/aave/build";
import { simulateBatch, type SimulationResult } from "@/server/simulate";
import type { Call } from "@/server/safe/multisend";
import type { Address, ChainId, SafeTx } from "@/shared/types";
import { adapterFor, offeredMarkets, type LenderId } from "@/server/lenders";
import { lenderOfSpec } from "./lender-of";
import { checkInvariants } from "./invariants";

export type TestRunResult = {
  ok: boolean;
  /** The sentence for the card. */
  line: string;
  /** False disables "Send to Safe"; `reason` says why. */
  canSend: boolean;
  reason?: string;
  /** About: an estimate. */
  feeUsd: number;
  /** Aave health factor after the batch (Infinity: no debt), null when the batch failed. */
  healthAfter: number | null;
  tx: SafeTx;
  steps: string[];
  failedStep?: number;
};

/** Spec of a protect proposal needs the loan's assets, which the spec only names by id. */
export type LoanHint = { collAsset: Asset; debtAsset: "USDC" };

const collateralOf = (a: Asset): CollateralAsset => {
  if (a === "ETH" || a === "wstETH") return a;
  throw new Error(`${a} is not available on this lender`);
};

function plan(p: { chainId: ChainId; safe: Address; spec: Spec; loan?: LoanHint; close?: Built; repay?: Built }): { built: Built; risk: "adds" | "reduces" } {
  const { chainId, safe, spec } = p;
  if (spec.kind === "open") {
    // Compound and Morpho are built by their adapter (BP-32); Aave keeps its own builder (M1 unchanged).
    if (spec.venueId === "compound-v3" || spec.venueId === "morpho-blue") {
      const lender = spec.venueId as LenderId;
      const collateral = spec.asset === "ETH" ? "WETH" : spec.asset;
      const row = offeredMarkets(chainId).find((m) => m.lender === lender && (m.collaterals as readonly string[]).includes(collateral));
      if (!row) throw new Error(`${spec.venueId} does not take ${spec.asset} on chain ${chainId}`);
      const ref = { lender, chainId, marketId: row.marketId, collateral: collateral as "WETH" | "wstETH" };
      return { built: adapterFor(lender).buildOpen({ ref, safe, collateral: { asset: spec.asset as "ETH" | "wstETH", amount: spec.amount }, borrow: spec.borrow }), risk: "adds" };
    }
    return {
      built: buildOpen({ chainId, safe, collateral: { asset: collateralOf(spec.asset), amount: spec.amount }, borrow: { asset: "USDC", amount: spec.borrow } }),
      risk: "adds",
    };
  }
  if (spec.kind === "protect") {
    if (!p.loan) throw new Error("a protect test run needs the loan's assets");
    const lender = lenderOfSpec(spec);
    if (lender !== "aave-v3") {
      // Compound and Morpho: the adapter builds the protect batch for the loan's own market.
      const collateral = p.loan.collAsset === "ETH" ? "WETH" : p.loan.collAsset;
      const row = offeredMarkets(chainId).find((m) => m.lender === lender && (m.collaterals as readonly string[]).includes(collateral));
      if (!row) throw new Error(`${lender} does not take ${p.loan.collAsset} on chain ${chainId}`);
      const ref = { lender, chainId, marketId: row.marketId, collateral: collateral as "WETH" | "wstETH" };
      return {
        built: adapterFor(lender).buildProtect({ ref, safe, ...(spec.addColl > 0 ? { addCollateral: { asset: p.loan.collAsset as "ETH" | "wstETH", amount: spec.addColl } } : {}), ...(spec.repay > 0 ? { repay: spec.repay } : {}) }),
        risk: "reduces",
      };
    }
    const parts: Built[] = [];
    if (spec.addColl > 0) parts.push(buildSupplyCollateral({ chainId, safe, asset: collateralOf(p.loan.collAsset), amount: spec.addColl }));
    if (spec.repay > 0) parts.push(buildRepay({ chainId, safe, asset: p.loan.debtAsset, amount: spec.repay }));
    if (parts.length === 0) throw new Error("nothing to do");
    return { built: combine(...parts), risk: "reduces" };
  }
  if (spec.kind === "close") {
    if (!p.close) throw new Error("a close test run needs the built batch");
    return { built: p.close, risk: "reduces" };
  }
  if (spec.kind === "repay") {
    // The batch comes from the caller (repay.ts): the loan's own adapter on its own market, for the exact amount typed.
    if (!p.repay) throw new Error("a repay test run needs the built batch");
    return { built: p.repay, risk: "reduces" };
  }
  throw new Error(`a test run for "${spec.kind}" is not built in M1`);
}

const feeText = (fee: number) => usd(fee, fee < 1 ? 2 : 0);

/** What a test run reads from outside: the Safe nonce and the simulation. `MOCK=1` swaps both. */
export type TestRunDeps = {
  readNonce: (chainId: ChainId, safe: Address) => Promise<bigint | null>;
  simulate: (p: { chainId: ChainId; safe: Address; calls: Required<Call>[] }) => Promise<SimulationResult>;
};

export const chainTestRunDeps: TestRunDeps = {
  readNonce: readSafeNonce,
  simulate: (p) => simulateBatch({ client: getPublicClient(p.chainId), ...p }),
};

export async function testRun(p: {
  chainId: ChainId;
  safe: Address;
  spec: Spec;
  healthBefore: number | null;
  /** The level below which the loan is "At risk" (the settings' act level). */
  atRiskLevel: number;
  loan?: LoanHint;
  /** The batch of a close, sized from the lender's position by the caller (`buildClose`). */
  close?: Built;
  /** The batch of a partial repay, built by the caller for the typed amount (`buildRepay`). */
  repay?: Built;
  /** Compound and Morpho: the simulation helper only reads Aave's account, so health after the batch is the plan's own figure (the adapter contract tests show it equals the lender's). */
  predictedHealthAfter?: number;
}, deps: TestRunDeps = chainTestRunDeps): Promise<TestRunResult> {
  const { built, risk } = plan(p);
  const nonce = (await deps.readNonce(p.chainId, p.safe)) ?? 0n;
  const tx = buildOuterTx(built.calls, nonce);
  const sim = await deps.simulate({ chainId: p.chainId, safe: p.safe, calls: built.calls });
  const healthAfter = sim.ok && p.predictedHealthAfter !== undefined ? p.predictedHealthAfter : sim.healthAfter;
  const base = { feeUsd: sim.feeUsd, healthAfter, tx, steps: built.steps };

  if (!sim.ok) {
    const step = sim.failedStep !== undefined ? built.steps[sim.failedStep] : undefined;
    const reason = step ? `The test run failed at "${step}".` : "The test run failed.";
    return { ...base, ok: false, canSend: false, reason, line: `${reason} Nothing was sent.`, ...(sim.failedStep !== undefined ? { failedStep: sim.failedStep } : {}) };
  }

  const inv = checkInvariants({ chainId: p.chainId, safe: p.safe, calls: built.calls, outer: tx, risk, healthBefore: p.healthBefore, healthAfter, simulationOk: true });
  if (!inv.ok) {
    const reason = `Test run failed: ${inv.reason}.`;
    return { ...base, ok: false, canSend: false, reason, line: reason };
  }
  const close = healthAfter !== null && healthAfter < p.atRiskLevel;
  const line = close ? `Checked: this would work, but it is close to liquidation. Network fee about ${feeText(sim.feeUsd)}.` : `Checked: this would work. Network fee about ${feeText(sim.feeUsd)}.`;
  return { ...base, ok: true, canSend: true, line };
}
