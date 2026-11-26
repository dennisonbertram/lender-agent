// Loans from chain (BP-17): the Safe's Aave loans as views, with the lender's own health factor at a
// named block, plus balances by network and (for one loan) the snapshot history and open proposals.
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { liquidationPrice as liqPrice, DEFAULT_LEVELS, healthStatus, maxPriceDrop, yearlyInterest, type HealthStatus, type Levels } from "@/lib/loan-math";
import { limitBar, limitUsedPct, loanRowLine, statusSentence } from "@/lib/loan-copy";
import type { Loan } from "@/lib/types";
import { offeredMarkets } from "@/server/lenders/allowlist";
import { AAVE_VENUE_NAME, liveInputs, type LiveInputs } from "@/server/market-inputs";
import { figuresOfLoan } from "@/server/quote";
import { AAVE } from "@/server/chain/config";
import { proposals, snapshots } from "@/server/db/schema";
import { levelsByLoan, levelsFor } from "@/server/levels";
import { checkWorkerHealth, workerStallLimitMs } from "@/worker/health";
import { monitorStatusFor, type MonitorStatus } from "@/server/monitor/status";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import { NETWORK_OF, type Address, type ChainId, type LoanPosition } from "@/shared/types";

const DAY_MS = 86_400_000;
const ASSET_ORDER = ["ETH", "wstETH", "WBTC", "USDC", "DAI"] as const;

/** A loan as the shell shows it: the position plus its health now. */
export type ShellLoanView = Omit<Loan, "debt"> & { debt: number | null; hf: number | null; status: HealthStatus };

export type LoanView = {
  id: string;
  chainId: ChainId;
  network: string;
  lender: string;
  collateral: { asset: string; amount: number; usd: number | null }[];
  debt: { asset: string; amount: number | null; usd: number | null };
  /** The lender's own value at `blockNumber`; null when there is no debt (never Infinity: JSON turns it into null). */
  healthFactor: number | null;
  status: HealthStatus;
  /** The owner's Watch and At-risk levels for this loan (defaults when never saved). */
  levels: Levels;
  /** "ETH can fall 40% before liquidation" (or a below/near-liquidation variant). */
  canFallPct: string;
  /** Row line: "Borrowed $X · {asset} can fall N% before liquidation". */
  rowLine: string;
  /** Share of the collateral price that can fall before liquidation, 0..1. */
  maxDrop: number;
  /** Null when the position has several collateral assets (D-05) or no debt. */
  liquidationPrice: number | null;
  /** Price of the (single) collateral asset now, or null when mixed. */
  collateralPrice: number | null;
  /** Null when the rate is not known (unsupported pair). */
  apr: number | null;
  yearlyInterest: number | null;
  limit: { used: number; fill: number; tick: number | null; text: string };
  /** What to check on the chain: the lending contract (Morpho: market id) and the token addresses. Symbols are the token's own (WETH stays WETH). */
  onchain: { market: { kind: "address" | "id"; value: string }; collateral: { symbol: string; address: string }[]; debt: { symbol: string; address: string }[] };
  blockNumber: number;
  readAt: number;
  mixed: boolean;
  /** The agent is a proposer on this loan's network. */
  watched: boolean;
  /** Whether a partial repayment can be safely proposed for this market. */
  repaymentEligible: boolean;
  /** Why partial repayment is unavailable, when it is not supported. */
  repaymentUnavailableReason?: string;
  /** The sidebar shape. */
  shell: ShellLoanView;
};

export type NetworkBalances = { chainId: ChainId; network: string; assets: { asset: string; amount: number; usd: number | null; priceBasis?: "observed" | "assumed $1 peg" }[]; totalUsd: number | null; blockNumber: number };

export type LoansResult = {
  loans: LoanView[];
  balancesByNetwork: NetworkBalances[];
  /** False when a supported lender position could not be read, so loan/debt totals may be incomplete. */
  loanReadsComplete: boolean;
  /** No owned network has the agent added: the overview says "Not watched". */
  watched: boolean;
  /** The one-line answer to "am I OK?" (empty when there are no loans). */
  sentence: string;
  /** The monitor: last check time and data source for the dashboard (BP-18). Dates are ISO strings on the wire. */
  monitor: { state: MonitorStatus["state"]; lastCheckAt: string | null; source: string | null; /** The worker is alive and no check exists yet. */ firstCheckDue?: boolean };
};

export type HistoryPoint = { day: number; hf: number };
export type LoanDetail = { loan: LoanView; /** Hash of the executed proposal that opened this loan, when the app has it. */ openedTx: string | null; history: HistoryPoint[]; openProposalIds: string[]; price: number; monitor: LoansResult["monitor"] };

/** Dollar total of holdings; null when any value is unknown (never a made-up figure). */
export const sumUsd = (items: { usd: number | null }[]): number | null => items.reduce<number | null>((s, i) => (s === null || i.usd === null ? null : s + i.usd), 0);

const label = (asset: string) => (asset === "WETH" ? "ETH" : asset);

/** How a loan's debt reads everywhere (dashboard and sidebar): one asset keeps its own amount; several are shown as their dollar total (never a sum of raw amounts). */
export function debtDisplay(debt: LoanPosition["debt"]): { asset: string; amount: number | null; usd: number | null } {
  const usd = sumUsd(debt);
  return debt.length === 1 ? { asset: label(debt[0].asset), amount: debt[0].amount, usd } : { asset: "USD", amount: usd, usd };
}

/** A lender's position in the shape the view needs, whichever lender it is. */
type Norm = {
  id: string; lender: string; safe: Address; collateral: LoanPosition["collateral"]; debt: LoanPosition["debt"];
  /** The lender's own health; Infinity with no debt. */
  hf: number; lt: number; mixed: boolean; blockNumber: bigint;
  /** The lender's market id (Aave: the pool address). */
  marketId?: string;
  /** The loan in the library's shape when it is a single supported pair. */
  loan: Loan | undefined;
};

function marketOf(chainId: ChainId, n: Norm): LoanView["onchain"]["market"] {
  const id = n.marketId ?? AAVE[chainId]?.pool ?? "";
  return { kind: /^0x[0-9a-fA-F]{40}$/.test(id) ? "address" : "id", value: id };
}

function viewOf(chainId: ChainId, readAt: number, n: Norm, watched: boolean, saved: Map<string, Levels>): LoanView | null {
  if (n.collateral.length === 0 && n.debt.length === 0) return null;
  const network = NETWORK_OF[chainId];
  const single = n.loan && { ...n.loan, apr: Math.round(n.loan.apr * 100) / 100 }; // the quote's rounding (VC-02)
  const collateral = n.collateral.map((c) => ({ asset: label(c.asset), amount: c.amount, usd: c.usd }));
  const debtUsd = sumUsd(n.debt);
  const debt = debtDisplay(n.debt);
  const hf = n.hf;
  const hfWire = Number.isFinite(hf) ? hf : null;
  const levels = levelsFor(saved, n.id);
  const status = healthStatus(hf, levels.warn, levels.act);
  const mixed = n.mixed || !single;
  const collAsset = collateral.length === 1 ? collateral[0].asset : "Your collateral";
  const loan: Loan = single ?? {
    id: n.id, safeId: n.safe.toLowerCase(), network, venue: n.lender, collAsset: (collateral[0]?.asset ?? "ETH") as Loan["collAsset"],
    collAmount: collateral[0]?.amount ?? 0, debtAsset: "USDC", debt: debtUsd ?? 0, lt: n.lt, apr: 0, accrued: 0,
  };
  const price = !mixed && single && single.collAmount > 0 && collateral[0].usd !== null ? collateral[0].usd / single.collAmount : null;
  // The figures come from the quote's math (VC-02): the same rate, yearly cost and liquidation price a plan card showed.
  const fig = single && price !== null ? figuresOfLoan(single, price, { health: hf }) : null;
  const apr = fig ? fig.apr : null;
  const liquidationPrice = fig && single!.debt > 0 ? fig.liqPrice : null;
  const used = limitUsedPct(hf);
  // The row line uses the lender's health: price and liquidation price in the ratio hf : 1.
  const rowLine = debtUsd === null
    ? `Debt value unavailable · ${loanRowLine(collAsset, hf, 1, 1).split(" · ")[1] ?? "health is unavailable"}`
    : loanRowLine(collAsset, hf, 1, debtUsd);
  const repaymentEligible = !n.id.endsWith(":compound-v3");
  return {
    id: n.id, chainId, network, lender: n.lender, collateral,
    debt,
    healthFactor: hfWire, status, levels,
    canFallPct: rowLine.includes(" · ") ? rowLine.split(" · ")[1] : rowLine,
    rowLine, maxDrop: maxPriceDrop(hf), liquidationPrice, collateralPrice: price,
    apr, yearlyInterest: fig ? fig.yearly : apr === null ? null : yearlyInterest(debtUsd ?? single?.debt ?? 0, apr),
    limit: { used, ...limitBar(used) },
    onchain: {
      market: marketOf(chainId, n),
      collateral: n.collateral.map((c) => ({ symbol: c.asset, address: c.token })),
      debt: n.debt.map((d) => ({ symbol: d.asset, address: d.token })),
    },
    blockNumber: Number(n.blockNumber), readAt, mixed, watched, repaymentEligible,
    ...(!repaymentEligible ? { repaymentUnavailableReason: "Compound v3 can supply any amount above the remaining debt as collateral. Partial repayment is unavailable; close the loan when you intend to repay it in full." } : {}),
    shell: { ...loan, debtAsset: debt.asset as Loan["debtAsset"], debt: debt.amount, hf: hfWire, status },
  };
}

/** The monitor tick reads every allowlisted lender (monitor/tick.ts), so only those loans are watched. */
const coveredByMonitor = (chainId: ChainId, lender: string): boolean => offeredMarkets(chainId).some((m) => m.lender === lender);

/** Every loan on one network: the Aave account, then each other lender's. */
function viewsOf(chainId: ChainId, inputs: LiveInputs, watched: boolean, saved: Map<string, Levels>): LoanView[] {
  const out: (LoanView | null)[] = [];
  const pos = inputs.position;
  if (pos) out.push(viewOf(chainId, inputs.readAt, { id: pos.id, lender: AAVE_VENUE_NAME, safe: pos.safe, collateral: pos.collateral, debt: pos.debt, hf: pos.healthFactor, lt: pos.liquidationThreshold, mixed: pos.mixed, blockNumber: pos.blockNumber, loan: inputs.loans[0] }, watched, saved));
  for (const f of inputs.lenders) {
    const p = f.position;
    if (!p) continue;
    out.push(viewOf(chainId, inputs.readAt, {
      id: `${chainId}:${p.safe.toLowerCase()}:${f.id}`, lender: f.name, safe: p.safe, collateral: p.collateral, debt: p.debt,
      hf: p.health ?? Number.POSITIVE_INFINITY, lt: p.liquidationThreshold, mixed: p.mixed, blockNumber: p.blockNumber, marketId: p.marketId, loan: f.loan ?? undefined,
    }, watched && coveredByMonitor(chainId, f.id), saved));
  }
  return out.flatMap((v) => (v ? [v] : []));
}

/** Every owned network's loans and balances, each read at one named block (G4: owned networks only). */
export async function loansFor(ctx: SafeContext): Promise<LoansResult> {
  const { services, safe, networks, access } = ctx;
  const addr = safe.address as Address;
  const saved = ctx.db ? await levelsByLoan(ctx.db, safe.id) : new Map<string, Levels>();
  const now = new Date();
  const monitor = ctx.db ? await monitorStatusFor(ctx.db, safe.id, access.ownedChainIds, now) : null;
  const workerOk = ctx.db ? (await checkWorkerHealth(ctx.db, { now, limitMs: workerStallLimitMs() })).watching : false;
  const reads = await Promise.all(access.ownedChainIds.map(async (chainId) => ({
    chainId,
    inputs: await liveInputs(services.reader, chainId, addr, services.lenders),
    watched: networks.some((n) => n.chainId === chainId && n.agentAdded),
  })));
  const loans: LoanView[] = [];
  const balancesByNetwork: NetworkBalances[] = [];
  const loanReadsComplete = reads.every(({ inputs }) => inputs.lenders.every((f) => !f.readFailed));
  for (const { chainId, inputs, watched } of reads) {
    loans.push(...viewsOf(chainId, inputs, watched, saved));
    const displayPrices: Partial<Record<string, number>> = {
      ETH: inputs.observedPrices.ETH,
      wstETH: inputs.observedPrices.wstETH,
      WBTC: inputs.observedPrices.WBTC,
      USDC: inputs.observedPrices.USDC ?? 1,
      DAI: inputs.observedPrices.DAI ?? 1,
    };
    const assets = ASSET_ORDER
      .filter((a) => inputs.balances[a] > 0)
      .map((asset) => ({ asset: asset as string, amount: inputs.balances[asset], usd: displayPrices[asset] === undefined ? null : inputs.balances[asset] * displayPrices[asset]!, ...((asset === "USDC" || asset === "DAI") && inputs.observedPrices[asset] === undefined ? { priceBasis: "assumed $1 peg" as const } : { priceBasis: "observed" as const }) }));
    // WETH is shown as its own asset (not planned with), valued at the ETH oracle price.
    if (inputs.weth > 0) assets.splice(assets.findIndex((a) => a.asset === "ETH") + 1, 0, { asset: "WETH", amount: inputs.weth, usd: displayPrices.ETH === undefined ? null : inputs.weth * displayPrices.ETH, priceBasis: "observed" });
    if (assets.length) balancesByNetwork.push({ chainId, network: NETWORK_OF[chainId], assets, totalUsd: sumUsd(assets), blockNumber: Number(inputs.blockNumber) });
  }
  const worst = loans.filter((l) => l.status === "liquidatable" || l.status === "risk" || l.status === "watch").sort((a, b) => (a.healthFactor ?? Infinity) - (b.healthFactor ?? Infinity))[0];
  const incompleteLine = "Could not check every lending market; some loan balances may be missing.";
  const knownSentence = statusSentence(loans.map((l) => l.status), worst?.lender);
  // No all-clear headline can be true when an unread market could contain another loan.
  const sentence = loanReadsComplete ? knownSentence : incompleteLine;
  return {
    loans, balancesByNetwork, loanReadsComplete,
    watched: networks.some((n) => access.ownedChainIds.includes(n.chainId as ChainId) && n.agentAdded),
    sentence,
    monitor: { state: monitor?.state ?? "not_watched", lastCheckAt: monitor?.lastCheckAt?.toISOString() ?? null, source: monitor?.source ?? null, firstCheckDue: workerOk && !!monitor && monitor.state !== "not_watched" && !monitor.lastCheckAt },
  };
}

/** One loan, with its recorded health history (snapshots, oldest first) and open proposals. 404 when not found. */
export async function loanDetail(ctx: SafeContext, loanId: string, now = new Date()): Promise<LoanDetail> {
  const { loans, monitor } = await loansFor(ctx);
  const loan = loans.find((l) => l.id.toLowerCase() === loanId.toLowerCase());
  if (!loan) throw new HttpError(404, "Loan not found");
  const { db, safe } = ctx;
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const rows = await db.select().from(snapshots)
    .where(and(eq(snapshots.safeId, safe.id), eq(snapshots.loanId, loan.id), gte(snapshots.at, since)))
    .orderBy(asc(snapshots.at), asc(snapshots.id));
  const history = rows
    .map((r) => ({ day: (r.at.getTime() - now.getTime()) / DAY_MS, hf: Number(r.health) }))
    .filter((p) => Number.isFinite(p.hf) && p.day <= 0);
  const open = await db.select().from(proposals)
    .where(and(eq(proposals.safeId, safe.id), eq(proposals.chainId, loan.chainId), inArray(proposals.stage, ["queued", "sending"])))
    .orderBy(asc(proposals.createdAt));
  const openProposalIds = open
    .filter((p) => (p.spec as { loanId?: string }).loanId?.toLowerCase() === loan.id.toLowerCase())
    .map((p) => p.id);
  const opened = await db.select({ spec: proposals.spec, hash: proposals.executedTxHash }).from(proposals)
    .where(and(eq(proposals.safeId, safe.id), eq(proposals.chainId, loan.chainId), eq(proposals.stage, "executed")))
    .orderBy(desc(proposals.createdAt));
  const venue = loan.id.split(":")[2];
  const openedTx = opened.find((p) => p.hash && (p.spec as { kind?: string; venueId?: string }).kind === "open" && (p.spec as { venueId?: string }).venueId === venue)?.hash ?? null;
  return { loan, openedTx, history, openProposalIds, price: loan.collateralPrice ?? 0, monitor };
}
