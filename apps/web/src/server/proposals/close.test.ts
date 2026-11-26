import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadThread } from "@/server/agent/persist";
import { activity, proposals } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { mockExecute } from "@/server/mock/safe-wallet";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import type { LoanPosition, Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import type { FixtureLenders } from "@/server/lenders/fixture";
import { closeLoan } from "./close";
import { adapterFor, COMET_USDC_BASE, MORPHO_WETH_USDC_ID, type AdapterPosition, type LenderId } from "@/server/lenders";
import { encodeFunctionData } from "viem";
import { cometAbi, morphoAbi } from "@/server/lenders/abis";
import { refreshProposal } from "./follow";
import { checkStale } from "./stale";
import { SendBlocked } from "./send";
import { pollDeposits } from "@/server/deposits/poll";
import { markStaleAll } from "./stale";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const LOAN_ID = `8453:${SAFE.toLowerCase()}:aave-v3`;
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;
const fake = () => w.services.fakes.get(8453)!;
const position = (debt = 2000): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: LOAN_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }],
  debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_001n,
});

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
  w.services.fixture.setPosition(8453, SAFE, position());
  w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 2500 });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => w.reset());

const rows = () => w.db.select().from(proposals);

describe("closeLoan (BP-26)", () => {
  it("queues one batch that repays all debt with a computed amount and withdraws all collateral to the Safe; the outcome states both amounts", async () => {
    const r = await closeLoan(ctx, { loanId: LOAN_ID });
    expect(r.stage).toBe("queued");
    const [row] = await rows();
    expect(row.spec).toMatchObject({ kind: "close", loanId: LOAN_ID });
    expect(row.outcome).toContain("2,000 USDC");
    expect(row.outcome).toMatch(/2(\.00)? WETH/);
    expect(row.title).toBe("Close Aave v3 loan");
    const tx = row.tx as { operation: number; data: Hex };
    expect(tx.operation).toBe(1); // one batch: allow, repay, withdraw
    const repay = /573ade81[0-9a-f]{64}([0-9a-f]{64})/.exec(tx.data.toLowerCase());
    expect(repay).not.toBeNull();
    expect(BigInt("0x" + repay![1])).toBe(2n ** 256n - 1n); // the maximum value: takes exactly the debt at execution
    const approve = /095ea7b3[0-9a-f]{64}([0-9a-f]{64})/.exec(tx.data.toLowerCase());
    expect(BigInt("0x" + approve![1])).toBeGreaterThan(2_000_000_000n + 2_000_000_000n / 1000n); // debt, margin and interest for the signing delay
    expect(row.steps.at(-1)).toMatch(/Withdraw/);
    const acts = await w.db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(acts.some((a) => a.kind === "proposed" && /Close/.test(a.text))).toBe(true);
  });

  it("not enough stablecoin: says how much is missing and drafts nothing", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 1500 });
    const err = await closeLoan(ctx, { loanId: LOAN_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(SendBlocked);
    expect(err.line).toMatch(/Add \$5\d\d(\.\d\d)? more USDC/);
    expect(err.line).toMatch(/Nothing was sent/);
    expect(await rows()).toHaveLength(0);
  });

  it("asking twice gives the one open close proposal (one open proposal per loan action)", async () => {
    const a = await closeLoan(ctx, { loanId: LOAN_ID });
    const b = await closeLoan(ctx, { loanId: LOAN_ID });
    expect(b.proposalId).toBe(a.proposalId);
    expect(await rows()).toHaveLength(1);
  });

  it("coalesces overlapping close requests that both pass the initial open check", async () => {
    const readThreshold = w.services.reader.readSafeThreshold.bind(w.services.reader);
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => { release = resolve; });
    let ready = 0;
    const threshold = vi.spyOn(w.services.reader, "readSafeThreshold").mockImplementation(async (...args) => {
      if (++ready === 2) release();
      await bothReady;
      return readThreshold(...args);
    });
    try {
      const [first, second] = await Promise.all([closeLoan(ctx, { loanId: LOAN_ID }), closeLoan(ctx, { loanId: LOAN_ID })]);
      expect(second.proposalId).toBe(first.proposalId);
      expect(await rows()).toHaveLength(1);
    } finally {
      threshold.mockRestore();
    }
  });

  it("the Safe's USDC covers the debt but not the approval: refused with the missing amount", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 2001 });
    const err = await closeLoan(ctx, { loanId: LOAN_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(SendBlocked);
    expect(err.line).toMatch(/Add \$\d+(\.\d\d)? more USDC/);
  });

  it("a close goes out of date when the Safe's USDC no longer covers what it approved, not when interest grows within the approval", async () => {
    const r = await closeLoan(ctx, { loanId: LOAN_ID });
    w.services.fixture.setPosition(8453, SAFE, position(2002));
    expect(await checkStale(w.db, w.services, r.proposalId)).toBe(false);
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 2001 });
    expect(await checkStale(w.db, w.services, r.proposalId)).toBe(true);
  });

  it("no loan: refuses", async () => {
    w.services.fixture.setPosition(8453, SAFE, null);
    await expect(closeLoan(ctx, { loanId: LOAN_ID })).rejects.toMatchObject({ status: 409 });
  });

  it("interest accruing while it waits does not make a close out of date; a vanished loan does", async () => {
    const r = await closeLoan(ctx, { loanId: LOAN_ID });
    w.services.fixture.setPosition(8453, SAFE, position(2000.37));
    expect(await checkStale(w.db, w.services, r.proposalId)).toBe(false);
    w.services.fixture.setPosition(8453, SAFE, null);
    expect(await checkStale(w.db, w.services, r.proposalId)).toBe(true);
  });

  it("after execution: \"Done. Your Aave v3 loan is closed.\" with both amounts", async () => {
    const r = await closeLoan(ctx, { loanId: LOAN_ID });
    const [row] = await rows();
    await mockExecute(w.services, 8453, row.safeTxHash as Hex);
    expect(w.services.fixture.state.positions.get(`8453:${SAFE.toLowerCase()}`)).toBeNull();
    await refreshProposal(w.db, w.services, r.proposalId);
    const msgs = await loadThread(w.db, safeId);
    const done = msgs.find((m) => m.id === `done-${r.proposalId}`)!;
    const text = done.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(text).toMatch(/^Done\. Your Aave v3 loan is closed\./);
    expect(text).toContain("2,000 USDC");
    expect(text).toMatch(/2(\.00)? WETH/);
    const [after] = await rows();
    expect(after.stage).toBe("executed");
  });
});

describe("closeLoan picks the exact loan and its lender's builder", () => {
  const MARKETS = { "compound-v3": COMET_USDC_BASE, "morpho-blue": MORPHO_WETH_USDC_ID } as const;
  const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
  const params = { loanToken: USDC, collateralToken: WETH, oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4", irm: "0x46415998764C29aB2a25CbeA6254146D50D22687", lltv: 860000000000000000n } as const;
  const lenderBatch: Record<"compound-v3" | "morpho-blue", { to: `0x${string}`; data: Hex; step: string }> = {
    "compound-v3": { to: COMET_USDC_BASE, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [WETH, 2n * 10n ** 18n] }), step: "Take all WETH back from Compound v3" },
    "morpho-blue": { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [params, 2n * 10n ** 18n, SAFE, SAFE] }), step: "Take all WETH back from Morpho" },
  };
  const held = (lender: "compound-v3" | "morpho-blue"): AdapterPosition => ({
    lender, chainId: 8453, safe: SAFE, marketId: MARKETS[lender],
    collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }], debt: [{ asset: "USDC", token: USDC, amount: 1500, usd: 1500 }],
    health: 2.1, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 57_172_001n,
  });
  const idOf = (l: LenderId) => `8453:${SAFE.toLowerCase()}:${l}`;

  it.each(["compound-v3", "morpho-blue"] as const)("%s: queues that lender's close batch, not Aave's", async (lender) => {
    w.services.fixture.setPosition(8453, SAFE, null); // no Aave loan at all
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 2500 });
    (w.services.lenders as FixtureLenders).setPosition({ lender, chainId: 8453, marketId: MARKETS[lender], collateral: "WETH" }, SAFE, held(lender));
    const b = lenderBatch[lender];
    const spy = vi.spyOn(adapterFor(lender), "buildClose").mockResolvedValue({ calls: [{ to: b.to, value: 0n, data: b.data }], steps: [b.step] });
    try {
      const r = await closeLoan(ctx, { loanId: idOf(lender) });
      expect(r.stage).toBe("queued");
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0]![0].ref.marketId).toBe(MARKETS[lender]);
      const [row] = await rows();
      expect(row.spec).toMatchObject({ kind: "close", loanId: idOf(lender) });
      expect(row.title).not.toBe("Close Aave v3 loan");
      expect((row.tx as { to: string; data: Hex }).data.toLowerCase()).toContain(b.data.slice(2, 10));
      expect((row.tx as { to: string }).to.toLowerCase()).toBe(b.to.toLowerCase());
    } finally { spy.mockRestore(); }
  });

  it("an Aave id does not close the Compound loan, and a Compound id does not close the Aave one", async () => {
    (w.services.lenders as FixtureLenders).setPosition({ lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" }, SAFE, held("compound-v3"));
    const spy = vi.spyOn(adapterFor("compound-v3"), "buildClose").mockResolvedValue({ calls: [{ to: COMET_USDC_BASE, value: 0n, data: lenderBatch["compound-v3"].data }], steps: ["x"] });
    try {
      const r = await closeLoan(ctx, { loanId: idOf("aave-v3") });
      expect(spy).not.toHaveBeenCalled();
      expect(r.stage).toBe("queued");
      expect((await rows())[0]!.title).toBe("Close Aave v3 loan");
    } finally { spy.mockRestore(); }
  });

  it.each([
    ["an unknown lender", `8453:${SAFE.toLowerCase()}:nope`],
    ["another Safe's loan", `8453:0x00000000000000000000000000000000000000b2:aave-v3`],
    ["an unknown network", `1:${SAFE.toLowerCase()}:aave-v3`],
    ["a bare chain id", "8453"],
    ["extra segments", `8453:${SAFE.toLowerCase()}:aave-v3:x`],
  ])("%s is 404 and drafts nothing", async (_n, id) => {
    await expect(closeLoan(ctx, { loanId: id })).rejects.toMatchObject({ status: 404 });
    expect(await rows()).toHaveLength(0);
  });
});

describe("a queued close goes out of date (BP-26)", () => {
  const stage = async () => (await rows())[0]!.stage;
  const queued = async () => { await closeLoan(ctx, { loanId: LOAN_ID }); return (await rows())[0]!; };

  it("stays queued while debt, balance and deadline are all fine", async () => {
    const row = await queued();
    expect(await checkStale(w.db, w.services, row.id)).toBe(false);
    expect(await stage()).toBe("queued");
  });

  it("stores the signing deadline with the close", async () => {
    const row = await queued();
    const deadline = Date.parse((row.spec as { deadline: string }).deadline);
    expect(deadline - row.createdAt.getTime()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(deadline - row.createdAt.getTime()).toBeLessThan(7.1 * 24 * 3600_000);
  });

  it("current debt above the approved amount: stale (approval 2,0xx USDC, debt 2,500)", async () => {
    const row = await queued();
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 3000 });
    w.services.fixture.setPosition(8453, SAFE, position(2500));
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
    expect(await stage()).toBe("stale");
  });

  it("the Safe's stablecoin dropped below the approved amount: stale", async () => {
    const row = await queued();
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 2001 });
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
  });

  it("the signing deadline passed: stale", async () => {
    const row = await queued();
    const spec = { ...(row.spec as object), deadline: new Date(Date.now() - 1000).toISOString() };
    await w.db.update(proposals).set({ spec }).where(eq(proposals.id, row.id));
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
  });

  it("the loan is gone (a successful read with no position): stale", async () => {
    const row = await queued();
    w.services.fixture.setPosition(8453, SAFE, null);
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
  });

  it("a Compound close survives a temporary read failure and recovery", async () => {
    w.services.fixture.setPosition(8453, SAFE, null);
    const lenders = w.services.lenders as FixtureLenders;
    lenders.setPosition({ lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" }, SAFE, {
      lender: "compound-v3", chainId: 8453, safe: SAFE, marketId: COMET_USDC_BASE,
      collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }], debt: [{ asset: "USDC", token: USDC, amount: 1500, usd: 1500 }],
      health: 2.1, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 57_172_001n,
    });
    const data = encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [WETH, 2n * 10n ** 18n] });
    const spy = vi.spyOn(adapterFor("compound-v3"), "buildClose").mockResolvedValue({ calls: [{ to: COMET_USDC_BASE, value: 0n, data }], steps: ["Take all WETH back from Compound v3"] });
    try {
      await closeLoan(ctx, { loanId: `8453:${SAFE.toLowerCase()}:compound-v3` });
    } finally { spy.mockRestore(); }
    const id = (await rows())[0]!.id;
    lenders.fail("compound-v3");
    expect(await checkStale(w.db, w.services, id)).toBe(false);
    await markStaleAll(w.db, w.services);
    expect(await stage()).toBe("queued");
    lenders.fail("compound-v3", false);
    expect(await checkStale(w.db, w.services, id)).toBe(false);
    expect(await stage()).toBe("queued");
  });
});

describe("deposits next to a real close (BP-31)", () => {
  it("an unrelated wstETH deposit in the poll of an executed close is still announced; the returned WETH is not", async () => {
    const t0 = new Date();
    await pollDeposits({ db: w.db, reader: w.services.reader, now: t0, log: () => {} });
    const { deposits } = await import("@/server/db/schema");
    await w.db.delete(deposits); // the first poll of a new Safe announces what it holds; only the next rises count
    await closeLoan(ctx, { loanId: LOAN_ID });
    const [row] = await rows();
    await w.db.update(proposals).set({ stage: "executed", updatedAt: new Date(t0.getTime() + 1000) }).where(eq(proposals.id, row.id));
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 500, WETH: 2, wstETH: 1 });
    await pollDeposits({ db: w.db, reader: w.services.reader, now: new Date(t0.getTime() + 60_000), log: () => {} });
    expect((await w.db.select().from(deposits)).map((d) => d.asset)).toEqual(["wstETH"]);
  });
});
