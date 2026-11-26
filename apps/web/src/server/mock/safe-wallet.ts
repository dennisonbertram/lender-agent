// `MOCK=1` stand-in for Safe{Wallet}: owners confirm and execute a queued proposal. It changes the
// fake Transaction Service and the fixture chain the way real execution would, so the product's
// own polling (BP-15) sees the stages move. Used by `pnpm dev` with MOCK=1 and by the E2E suite.
// Never available outside mock mode.
import { and, eq, sql } from "drizzle-orm";
import { keccak256, toHex } from "viem";
import type { Spec } from "@/lib/proposals";
import { tokenBySymbol } from "@/server/chain/config";
import { proposals } from "@/server/db/schema";
import type { Services } from "@/server/services";
import type { Address, ChainId, Hex, LoanPosition } from "@/shared/types";
import { otherRefs } from "@/server/lenders/reads";
import type { FixtureLenders } from "@/server/lenders/fixture";

type MockServices = Services & Required<Pick<Services, "fixture" | "fakes">>;

export function asMock(services: Services): MockServices {
  if (!services.mock || !services.fixture || !services.fakes) throw new Error("The Safe{Wallet} stand-in exists only with MOCK=1");
  return services as MockServices;
}

/** An owner signs the transaction in "Safe{Wallet}". */
export function mockConfirm(services: Services, chainId: ChainId, safeTxHash: Hex, owner: Address) {
  asMock(services).fakes.get(chainId)!.confirm(safeTxHash, owner);
}

/**
 * Execute in "Safe{Wallet}": mark it executed in the fake service and apply an `open` spec to the
 * fixture chain (collateral leaves the Safe into Aave, USDC arrives). `revert: true` marks the
 * execution as failed: balances and loans stay, but the Safe nonce is used.
 */
export async function mockExecute(services: Services, chainId: ChainId, safeTxHash: Hex, opts: { revert?: boolean } = {}) {
  const s = asMock(services);
  const db = await s.db();
  const fake = s.fakes.get(chainId)!;
  const txHash = keccak256(toHex(`mock-exec:${safeTxHash}`));
  const safe = await fakeSafeOf(s, chainId, safeTxHash);
  if (!safe) throw new Error(`mock Safe{Wallet}: unknown transaction ${safeTxHash}`);
  if (opts.revert) {
    // A failed execution is still mined: it uses the Safe nonce, so the next plan gets a new one (and a new hash).
    const used = await s.fixture.readSafeNonce(chainId, safe);
    if (used !== null) s.fixture.setNonce(chainId, safe, used + 1n);
    s.fixture.mine();
    fake.markExecuted(safeTxHash, { success: false, txHash });
    return { success: false, txHash };
  }
  const [row] = await db.select().from(proposals)
    .where(and(eq(proposals.chainId, chainId), sql`lower(${proposals.safeTxHash}) = ${safeTxHash.toLowerCase()}`)).limit(1);
  const spec = row?.spec as Spec | undefined;
  if (spec?.kind === "open") await applyOpen(s, chainId, safe, spec);
  if (spec?.kind === "close") applyClose(s, chainId, safe);
  if (spec?.kind === "repay") {
    const repaymentAmount = await applyRepay(s, chainId, safe, spec);
    await db.update(proposals).set({ testRun: { ...((row?.testRun ?? {}) as Record<string, unknown>), repaymentAmount } })
      .where(and(eq(proposals.chainId, chainId), sql`lower(${proposals.safeTxHash}) = ${safeTxHash.toLowerCase()}`));
  }
  if (spec?.kind === "move") applyMove(s, chainId, safe, spec); // E9: the funds leave the source network
  const nonce = await s.fixture.readSafeNonce(chainId, safe);
  if (nonce !== null) s.fixture.setNonce(chainId, safe, nonce + 1n);
  s.fixture.mine();
  fake.markExecuted(safeTxHash, { success: true, txHash });
  return { success: true, txHash };
}

async function fakeSafeOf(s: MockServices, chainId: ChainId, safeTxHash: Hex): Promise<Address | null> {
  const tx = await s.fakes.get(chainId)!.getMultisigTransaction(safeTxHash);
  return (tx?.safe as Address | undefined) ?? null;
}

async function applyOpen(s: MockServices, chainId: ChainId, safe: Address, spec: Extract<Spec, { kind: "open" }>) {
  const state = s.fixture.state;
  const k = `${chainId}:${safe.toLowerCase()}`;
  const held: Record<string, number> = {};
  for (const b of state.balances.get(k) ?? []) held[b.symbol] = b.amount;
  const collSymbol = spec.asset === "ETH" ? "WETH" : spec.asset;
  held[spec.asset] = Math.max(0, (held[spec.asset] ?? 0) - spec.amount);
  held.USDC = (held.USDC ?? 0) + spec.borrow;
  s.fixture.setBalances(chainId, safe, held);

  // A Morpho or Compound plan opens that lender's position (the Aave account is untouched).
  if (spec.venueId !== "aave-v3") { await applyOtherLenderOpen(s, chainId, safe, spec, collSymbol); return; }

  const prev = state.positions.get(k) ?? null;
  const price = state.prices[collSymbol] ?? 0;
  const token = tokenBySymbol(chainId, collSymbol)!;
  const usdc = tokenBySymbol(chainId, "USDC")!;
  const market = [...state.markets.values()].find((m) => m.symbol === collSymbol)!;
  const collAmount = (prev?.collateral[0]?.amount ?? 0) + spec.amount;
  const debt = (prev?.debt[0]?.amount ?? 0) + spec.borrow;
  const position: LoanPosition = {
    chainId, safe, lender: "aave-v3", id: `${chainId}:${safe.toLowerCase()}:aave-v3`,
    collateral: [{ asset: collSymbol, token: token.address!, amount: collAmount, usd: collAmount * price }],
    debt: [{ asset: "USDC", token: usdc.address!, amount: debt, usd: debt }],
    healthFactor: debt > 0 ? (collAmount * price * market.liquidationThreshold) / debt : Infinity,
    liquidationThreshold: market.liquidationThreshold, ltv: market.ltv, mixed: false, blockNumber: state.blockNumber,
  };
  s.fixture.setPosition(chainId, safe, position);
}

async function applyOtherLenderOpen(s: MockServices, chainId: ChainId, safe: Address, spec: Extract<Spec, { kind: "open" }>, collSymbol: string) {
  const lenders = s.lenders as FixtureLenders | undefined;
  const ref = otherRefs(chainId).find((r) => r.lender === spec.venueId && r.collateral === collSymbol);
  if (!lenders || !("setPosition" in lenders) || !ref) throw new Error(`mock Safe{Wallet}: no ${spec.venueId} market for ${collSymbol} on chain ${chainId}`);
  // A position already on the fixture chain (set by a test or an earlier open) grows by this open, like the Aave one.
  const prev = await lenders.position(ref, safe);
  const price = s.fixture.state.prices[collSymbol] ?? 0;
  const token = tokenBySymbol(chainId, collSymbol)!;
  const usdc = tokenBySymbol(chainId, "USDC")!;
  const collAmount = (prev?.collateral[0]?.amount ?? 0) + spec.amount;
  const debt = (prev?.debt[0]?.amount ?? 0) + spec.borrow;
  lenders.setPosition(ref, safe, {
    lender: ref.lender, chainId, safe, marketId: ref.marketId,
    collateral: [{ asset: collSymbol, token: token.address!, amount: collAmount, usd: collAmount * price }],
    debt: [{ asset: "USDC", token: usdc.address!, amount: debt, usd: debt }],
    health: debt > 0 ? (collAmount * price * 0.86) / debt : null,
    liquidatable: false, liquidationThreshold: ref.lender === "morpho-blue" ? 0.86 : 0.85, mixed: false, blockNumber: s.fixture.state.blockNumber,
  });
}

/** A move: the amount leaves the Safe on the source network. What arrives on the destination is the move job's to prove, not the fixture's to invent. */
function applyMove(s: MockServices, chainId: ChainId, safe: Address, spec: Extract<Spec, { kind: "move" }>) {
  const k = `${chainId}:${safe.toLowerCase()}`;
  const held: Record<string, number> = {};
  for (const b of s.fixture.state.balances.get(k) ?? []) held[b.symbol] = b.amount;
  held[spec.move.asset] = Math.max(0, (held[spec.move.asset] ?? 0) - spec.move.amount);
  s.fixture.setBalances(chainId, safe, held);
}

/** A partial repay: the typed amount leaves the Safe's USDC and the loan's own USDC debt shrinks by it — the same lender, market and asset the batch paid. */
async function applyRepay(s: MockServices, chainId: ChainId, safe: Address, spec: Extract<Spec, { kind: "repay" }> & { marketId?: string; collateral?: string }): Promise<number> {
  if (typeof spec.amount !== "number" || !Number.isFinite(spec.amount) || spec.amount <= 0) return 0;
  const state = s.fixture.state;
  const k = `${chainId}:${safe.toLowerCase()}`;
  // Only the USDC debt entry of this loan shrinks; every other asset's debt is untouched.
  const payDown = <D extends { asset: string; amount: number; usd: number | null }>(debt: D[], amount: number): D[] =>
    debt.map((d) => (d.asset === "USDC" ? { ...d, amount: Math.max(0, d.amount - amount), usd: d.usd === null ? null : Math.max(0, d.amount - amount) } : d));
  const healthAfter = (collateral: { usd: number | null }[], debt: { amount: number }[], lt: number) => {
    const total = debt.reduce((sum, d) => sum + d.amount, 0);
    const collUsd = collateral.reduce((sum, c) => sum + (c.usd ?? 0), 0);
    return total > 0 ? (collUsd * lt) / total : Number.POSITIVE_INFINITY;
  };

  const lender = spec.loanId.split(":")[2];
  if (lender === "aave-v3") {
    const prev = state.positions.get(k);
    if (!prev) return 0;
    const debtBefore = prev.debt.filter((d) => d.asset === "USDC").reduce((sum, d) => sum + d.amount, 0);
    const applied = Math.min(spec.amount, debtBefore);
    const debt = payDown(prev.debt, applied);
    const held: Record<string, number> = {};
    for (const b of state.balances.get(k) ?? []) held[b.symbol] = b.amount;
    held.USDC = Math.max(0, (held.USDC ?? 0) - applied);
    s.fixture.setBalances(chainId, safe, held);
    s.fixture.setPosition(chainId, safe, { ...prev, debt, healthFactor: healthAfter(prev.collateral, debt, prev.liquidationThreshold) });
    return applied;
  }
  const lenders = s.lenders as FixtureLenders | undefined;
  const ref = otherRefs(chainId).find((r) => r.lender === lender
    && (!spec.marketId || r.marketId.toLowerCase() === spec.marketId.toLowerCase())
    && (!spec.collateral || r.collateral.toLowerCase() === spec.collateral.toLowerCase()));
  if (!lenders || !("setPosition" in lenders)) throw new Error(`mock Safe{Wallet}: no ${lender} lender on chain ${chainId}`);
  const prev = ref ? await lenders.position(ref, safe) : null;
  if (!prev) return 0;
  const debtBefore = prev.debt.filter((d) => d.asset === "USDC").reduce((sum, d) => sum + d.amount, 0);
  const applied = Math.min(spec.amount, debtBefore);
  const debt = payDown(prev.debt, applied);
  lenders.setPosition(ref!, safe, { ...prev, debt, health: healthAfter(prev.collateral, debt, prev.liquidationThreshold) });
  const held: Record<string, number> = {};
  for (const b of state.balances.get(k) ?? []) held[b.symbol] = b.amount;
  // Comet `supplyTo` pulls the full amount even when some of it becomes supply instead of repaying debt.
  held.USDC = Math.max(0, (held.USDC ?? 0) - (lender === "compound-v3" ? spec.amount : applied));
  s.fixture.setBalances(chainId, safe, held);
  return applied;
}

/** A close: the debt is paid from the Safe's USDC and all collateral comes back as the ERC-20 the lender held. */
function applyClose(s: MockServices, chainId: ChainId, safe: Address) {
  const state = s.fixture.state;
  const k = `${chainId}:${safe.toLowerCase()}`;
  const prev = state.positions.get(k);
  if (!prev) return;
  const held: Record<string, number> = {};
  for (const b of state.balances.get(k) ?? []) held[b.symbol] = b.amount;
  for (const d of prev.debt) held[d.asset] = Math.max(0, (held[d.asset] ?? 0) - d.amount);
  for (const c of prev.collateral) held[c.asset] = (held[c.asset] ?? 0) + c.amount;
  s.fixture.setBalances(chainId, safe, held);
  s.fixture.setPosition(chainId, safe, null);
}
