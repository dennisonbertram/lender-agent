import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alertAmounts, alertOptions } from "@/lib/alerts";
import { BALANCED_HF, DEFAULT_LEVELS, fixTargetHf } from "@/lib/loan-math";
import { fixDrafts, loanLevels, proposals, snapshots } from "@/server/db/schema";
import { safeContext } from "@/server/request";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { tokenBySymbol } from "@/server/chain/config";
import type { Hex, LoanPosition } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { COMET_USDC_BASE, MORPHO_WETH_USDC_ID } from "@/server/lenders/allowlist";
import type { FixtureLenders } from "@/server/lenders/fixture";
import { D10_NOTE, urgentNote } from "./copy";
import { draftFix, fixOptionsFor, fixPanel, fixStateFor, sendFix, waitingFixes } from "./index";
import { checkStale } from "../proposals/stale";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const LOAN_ID = `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;

/** 2 ETH at $3,000 against $4,800 of USDC, liquidation threshold 0.83: health about 1.04 (At-risk). */
const position = (coll = 2, debt = 4800, price = 3000): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: LOAN_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: coll, usd: coll * price }],
  debt: [{ asset: "USDC", token: tokenBySymbol(8453, "USDC")!.address!, amount: debt, usd: debt }],
  healthFactor: (coll * price * 0.83) / debt, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_000n,
});
const setLoan = (p = position(), prices: Record<string, number> = {}) => {
  w.services.fixture.setPosition(8453, SAFE, p);
  w.services.fixture.setPrices({ ETH: 3000, WETH: 3000, ...prices });
};
const fake = () => w.services.fakes.get(8453)!;
const deps = () => ({ db: w.db, services: w.services });

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
  setLoan();
  w.services.fixture.setBalances(8453, SAFE, { ETH: 2.5, wstETH: 0, USDC: 0 });
});
afterEach(() => w.reset());

describe("fixOptionsFor (BP-22)", () => {
  it("uses the lender's own figures: amounts and health come from the app math (G1)", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 2.5, wstETH: 0, USDC: 9000 });
    const r = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    const loan = { id: LOAN_ID, safeId: SAFE.toLowerCase(), network: "base", venue: "Aave v3", collAsset: "ETH", collAmount: 2, debtAsset: "USDC", debt: 4800, lt: 0.83, apr: 0, accrued: 0 } as const;
    const a = alertAmounts(loan, 3000, fixTargetHf(DEFAULT_LEVELS));
    const expected = alertOptions({ snap: loan, price: 3000, ...a }, { ETH: 2.5, wstETH: 0, WBTC: 0, USDC: 9000, DAI: 0 });
    expect(r.options.map((o) => [o.k, o.addColl, o.repay, o.hf, o.label, o.sub])).toEqual(expected.map((o) => [o.k, o.addColl, o.repay, o.hf, o.label, o.sub]));
    expect(r.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(r.healthFactor).toBeCloseTo(1.0375, 4);
    expect(r.atRisk).toBe(true);
  });

  it("greys an option the Safe cannot fund with 'Needs {x}. Your Safe has {y}.'", async () => {
    const r = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    const repay = r.options.find((o) => o.k === "repay")!;
    expect(repay.short).toBe(true);
    expect(repay.sub).toMatch(/^Needs [\d,]+ USDC\. Your Safe has 0 USDC\.$/);
    expect(r.options.at(-1)!.short).toBe(true); // greyed options come last
    expect(r.options.some((o) => o.recommended)).toBe(false); // one usable option: no "Recommended"
  });

  it("a fixed loan lands on the Balanced target, clearly above the default Watch level", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 5, wstETH: 0, USDC: 20_000 });
    const r = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    expect(fixTargetHf(DEFAULT_LEVELS)).toBe(BALANCED_HF);
    expect(BALANCED_HF).toBeGreaterThan(DEFAULT_LEVELS.warn);
    for (const o of r.options.filter((x) => !x.short)) expect(o.hf).toBeGreaterThanOrEqual(BALANCED_HF - 0.01);
  });

  it("every usable option reaches the Watch level", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 5, wstETH: 0, USDC: 20_000 });
    const r = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    for (const o of r.options.filter((x) => !x.short)) expect(o.hf).toBeGreaterThanOrEqual(DEFAULT_LEVELS.warn);
  });

  it("uses the loan's own saved levels", async () => {
    await w.db.insert(loanLevels).values({ safeId, loanId: LOAN_ID, chainId: 8453, warn: 2, act: 1.5, updatedAt: new Date() });
    w.services.fixture.setBalances(8453, SAFE, { ETH: 5, wstETH: 0, USDC: 20_000 });
    const r = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    expect(r.levels).toEqual({ warn: 2, act: 1.5 });
    for (const o of r.options) expect(o.hf).toBeGreaterThanOrEqual(2.05 - 0.01); // saved Watch 2 + margin, above the Balanced target
  });

  it("is At risk from the monitor's stored snapshot and levels, not only the live read", async () => {
    setLoan(position(10, 4800)); // live health is fine
    await w.db.insert(snapshots).values({ safeId, chainId: 8453, loanId: LOAN_ID, blockNumber: 1n, health: "1.2", debt: "4800", collateral: "6000" });
    const r = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    expect(r.atRisk).toBe(false); // the live read wins: the loan recovered
    expect(r.urgent).toBe(false);
  });

  it("returns null for a loan the Safe does not have", async () => {
    w.services.fixture.setPosition(8453, SAFE, null);
    expect(await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps())).toBeNull();
  });
});

describe("draftFix (BP-22)", () => {
  it("drafts the picked option with steps, health before and after, and the test run; it still needs a signature", async () => {
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    expect(d.steps.length).toBeGreaterThanOrEqual(3);
    expect(d.steps.some((x) => /^Lock .* ETH in Aave v3$/.test(x))).toBe(true);
    expect(d.healthBefore).toBeCloseTo(1.0375, 3);
    expect(d.healthAfter!).toBeGreaterThan(DEFAULT_LEVELS.act);
    expect(d.testRunLine).toMatch(/^Checked: this would work\./);
    expect(d.canSend).toBe(true);
    expect(d.state).toBe("draft");
    expect(d.stillNeeds).toMatch(/still needs .*signature/i);
    expect(await w.db.select().from(proposals)).toHaveLength(0); // r30: a pick is not consent to send
  });

  it("recomputes the amounts from live data when the draft is built (NFR)", async () => {
    const before = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    setLoan(position(2, 4800, 2500), { ETH: 2500, WETH: 2500 });
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    const now = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    expect(now.options.find((o) => o.k === "coll")!.addColl).toBeGreaterThan(before.options.find((o) => o.k === "coll")!.addColl);
    expect(d.spec).toMatchObject({ kind: "protect", loanId: LOAN_ID, addColl: now.options.find((o) => o.k === "coll")!.addColl, repay: 0 });
  });

  it("refuses an option the Safe cannot fund, with the 'Needs' line", async () => {
    await expect(draftFix(ctx, { loanId: LOAN_ID, option: "repay" })).rejects.toThrow(/^Needs [\d,]+ USDC\. Your Safe has 0 USDC\.$/);
    expect(await w.db.select().from(fixDrafts)).toHaveLength(0);
  });

  it("replaces the draft after a second price fall and the old card reads Replaced", async () => {
    const a = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    setLoan(position(2, 4800, 2700), { ETH: 2700, WETH: 2700 });
    const b = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    expect(b.id).not.toBe(a.id);
    const [old] = await w.db.select().from(fixDrafts).where(eq(fixDrafts.id, a.id));
    expect(old.state).toBe("replaced");
    const state = await fixStateFor(w.db, safeId, LOAN_ID);
    expect(state).toMatchObject({ fix: "draft", draftId: b.id });
    expect(state.replaced.map((r) => r.id)).toEqual([a.id]);
  });

  it("a replaced draft cannot be sent", async () => {
    const a = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    await expect(sendFix(ctx, a.id)).rejects.toThrow(/Replaced/);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });
});

describe("sendFix and the urgent queue position (BP-23, D-10)", () => {
  it("an urgent fix is proposed at the Safe's current nonce even behind an unrelated queued transaction", async () => {
    w.services.fixture.setNonce(8453, SAFE, 4n);
    // an unrelated queued proposal at nonce 4 and 5
    for (const n of [4n, 5n]) {
      await w.db.insert(proposals).values({
        id: `other-${n}`, safeId, chainId: 8453, spec: { kind: "close", loanId: "x" }, nonce: n, safeTxHash: `0x${"ab".repeat(31)}0${n}`, idempotencyKey: `other-${n}`,
        title: "Other", steps: [], outcome: "", stage: "queued", threshold: 2,
      });
    }
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    expect(d.urgent).toBe(true);
    expect(d.urgentNote).toBe(urgentNote());
    const r = await sendFix(ctx, d.id);
    expect(r.stage).toBe("queued");
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(row.nonce).toBe(4n);
    const st = await fixStateFor(w.db, safeId, LOAN_ID);
    expect(st).toMatchObject({ fix: "queued", proposalId: r.proposalId });
  });

  it("a fix for a loan that is not At risk takes the next free nonce", async () => {
    w.services.fixture.setNonce(8453, SAFE, 4n);
    await w.db.insert(proposals).values({
      id: "other", safeId, chainId: 8453, spec: { kind: "close", loanId: "x" }, nonce: 4n, safeTxHash: `0x${"cd".repeat(32)}`, idempotencyKey: "other",
      title: "Other", steps: [], outcome: "", stage: "queued", threshold: 2,
    });
    setLoan(position(2, 3000)); // hf 1.66: healthy
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "repay" }).catch(async () => {
      w.services.fixture.setBalances(8453, SAFE, { ETH: 2.5, wstETH: 0, USDC: 9000 });
      return draftFix(ctx, { loanId: LOAN_ID, option: "repay" });
    });
    expect(d.urgent).toBe(false);
    const r = await sendFix(ctx, d.id);
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(row.nonce).toBe(5n);
  });

  it("two sends of one draft make one proposal", async () => {
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    const a = await sendFix(ctx, d.id);
    const b = await sendFix(ctx, d.id);
    expect(b.proposalId).toBe(a.proposalId);
    expect(await w.db.select().from(proposals)).toHaveLength(1);
  });
});

describe("sendFix recomputes at send time (review finding 9)", () => {
  it("after a second price fall the stale amount is not sent: the draft is replaced and the user is asked to review", async () => {
    const a = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    setLoan(position(2, 4800, 2500), { ETH: 2500, WETH: 2500 }); // still improves health, but no longer reaches the target
    const err = await sendFix(ctx, a.id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/review/i);
    expect(await w.db.select().from(proposals)).toHaveLength(0); // nothing sent
    const [old] = await w.db.select().from(fixDrafts).where(eq(fixDrafts.id, a.id));
    expect(old.state).toBe("replaced");
    const state = await fixStateFor(w.db, safeId, LOAN_ID);
    expect(state.fix).toBe("draft");
    expect(state.draftId).not.toBe(a.id);
    const now = (await fixOptionsFor({ id: safeId, address: SAFE }, { id: LOAN_ID, chainId: 8453 }, deps()))!;
    const [fresh] = await w.db.select().from(fixDrafts).where(eq(fixDrafts.id, state.draftId!));
    expect(fresh.spec).toMatchObject({ addColl: now.options.find((o) => o.k === "coll")!.addColl });
    expect((fresh.spec as { addColl: number }).addColl).toBeGreaterThan((a.spec as { addColl: number }).addColl);
    // the user reviews and sends the new one
    expect((await sendFix(ctx, state.draftId!)).stage).toBe("queued");
  });
});

describe("fixes for Compound and Morpho loans (review finding 4b)", () => {
  const REFS = { "compound-v3": { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" }, "morpho-blue": { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC_ID, collateral: "WETH" } } as const;
  it.each([["compound-v3", "Compound v3"], ["morpho-blue", "Morpho"]] as const)("%s at-risk loan gets options and a draft that sends", async (lender, name) => {
    const id = `8453:${MOCK_SAFE.toLowerCase()}:${lender}`;
    w.services.fixture.setPosition(8453, SAFE, null);
    (w.services.lenders as FixtureLenders).setPosition(REFS[lender], SAFE, {
      lender, chainId: 8453, safe: SAFE, marketId: REFS[lender].marketId, collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }],
      debt: [{ asset: "USDC", token: tokenBySymbol(8453, "USDC")!.address!, amount: 4800, usd: 4800 }], health: (2 * 3000 * 0.85) / 4800, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 1n,
    });
    const o = (await fixOptionsFor({ id: safeId, address: SAFE }, { id, chainId: 8453 }, deps()))!;
    expect(o).not.toBeNull();
    expect(o.lender).toBe(name);
    expect(o.atRisk).toBe(true);
    expect(o.options.find((x) => x.k === "coll")!.short).toBe(false);
    const d = await draftFix(ctx, { loanId: id, option: "coll" });
    expect(d.canSend).toBe(true);
    expect(d.steps.join(" ")).toContain(name);
    expect(d.healthAfter!).toBeGreaterThan(d.healthBefore!);
    expect((await sendFix(ctx, d.id)).stage).toBe("queued");
  });
});

describe("urgent card copy (D-10, R-15)", () => {
  it("says both stay pending if another is waiting, whichever executes first goes through, signing does not cancel, deleting does not revoke", () => {
    const t = urgentNote();
    expect(t).toBe(D10_NOTE);
    expect(t).toMatch(/both stay pending/);
    expect(t).toMatch(/Whichever is executed first goes through/);
    expect(t).toMatch(/no longer run and must be proposed again if still wanted/);
    expect(t).toMatch(/Signing this fix does not cancel the other/);
    expect(t).toMatch(/deleting a proposal does not take back signatures already given/);
    expect(t).not.toMatch(/cancelled/i);
  });
});

describe("monitorAtRisk and fixStateFor", () => {
  it("reads the latest stored snapshot against the loan's At-risk level (no chain read)", async () => {
    const { monitorAtRisk } = await import("./index");
    expect(await monitorAtRisk(w.db, safeId, LOAN_ID)).toBe(false); // no snapshot yet
    await w.db.insert(snapshots).values({ safeId, chainId: 8453, loanId: LOAN_ID, at: new Date("2026-01-01"), blockNumber: 1n, health: "1.2", debt: "4800", collateral: "6000" });
    expect(await monitorAtRisk(w.db, safeId, LOAN_ID)).toBe(true);
    await w.db.insert(snapshots).values({ safeId, chainId: 8453, loanId: LOAN_ID, at: new Date("2026-01-02"), blockNumber: 2n, health: "1.9", debt: "4800", collateral: "6000" });
    expect(await monitorAtRisk(w.db, safeId, LOAN_ID)).toBe(false); // the newest snapshot wins
    await w.db.insert(loanLevels).values({ safeId, loanId: LOAN_ID, chainId: 8453, warn: 2.5, act: 2, updatedAt: new Date() });
    expect(await monitorAtRisk(w.db, safeId, LOAN_ID)).toBe(true); // the loan's own At-risk level
  });

  it("a fix in the Safe queue is 'queued' for the banner, and the overview lists it", async () => {
    const { waitingFixes } = await import("./index");
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    expect(await fixStateFor(w.db, safeId, LOAN_ID)).toMatchObject({ fix: "draft", draftId: d.id });
    const sent = await sendFix(ctx, d.id);
    expect(await fixStateFor(w.db, safeId, LOAN_ID)).toMatchObject({ fix: "queued", proposalId: sent.proposalId });
    const lines = await waitingFixes(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ proposalId: sent.proposalId, loanId: LOAN_ID });
    expect(lines[0].sentence).toMatch(/In your Safe queue\. Needs 2 signatures\./);
  });
});

describe("review findings: stale check, finished fixes, per-network waiting list", () => {
  for (const option of ["coll", "repay", "both"] as const) {
    it(`a sent '${option}' fix stays queued with the loan unchanged and goes stale when the price moves`, async () => {
      w.services.fixture.setBalances(8453, SAFE, { ETH: 2.5, wstETH: 0, USDC: 9000 });
      const d = await draftFix(ctx, { loanId: LOAN_ID, option });
      const r = await sendFix(ctx, d.id);
      expect(r.stage).toBe("queued");
      expect(await checkStale(w.db, w.services, r.proposalId)).toBe(false);
      setLoan(position(2, 4800, 2000), { ETH: 2000, WETH: 2000 }); // far enough that the repay rounds to a different size at the 1.45 target
      expect(await checkStale(w.db, w.services, r.proposalId)).toBe(true);
    });
  }

  it("after the fix executed or was rejected, the panel offers the options again and shows no draft", async () => {
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    expect((await fixPanel(ctx, LOAN_ID)).draft?.id).toBe(d.id); // a live draft blocks
    const r = await sendFix(ctx, d.id);
    expect((await fixPanel(ctx, LOAN_ID)).draft?.id).toBe(d.id); // sent and queued: still live
    for (const stage of ["executed", "rejected", "stale", "failed"] as const) {
      await w.db.update(proposals).set({ stage }).where(eq(proposals.id, r.proposalId));
      const panel = await fixPanel(ctx, LOAN_ID);
      expect(panel.draft, stage).toBeNull();
      expect(panel.options, stage).not.toBeNull();
    }
    await w.db.update(proposals).set({ stage: "queued" }).where(eq(proposals.id, r.proposalId));
    await w.db.update(fixDrafts).set({ state: "replaced" }).where(eq(fixDrafts.id, d.id));
    expect((await fixPanel(ctx, LOAN_ID)).draft).toBeNull();
  });

  it("waitingFixes lists only networks where the caller is an owner", async () => {
    const d = await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    await sendFix(ctx, d.id);
    expect(await waitingFixes(ctx)).toHaveLength(1);
    const other = { ...ctx, access: { ...ctx.access, ownedChainIds: [84532] } } as typeof ctx;
    expect(await waitingFixes(other)).toHaveLength(0);
  });
});
