// BP-25 standing rule: stored per loan, edits and deletes in Activity (G3), run on a crossing through the
// existing fix functions, and its effect stated on the alert and in Settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftFix, sendFix } from "@/server/fixes";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activity, alerts, fixDrafts, messages, proposals, ruleRuns } from "@/server/db/schema";
import { alertView } from "@/server/alerts/view";
import { deliverAlerts } from "@/server/alerts/deliver";
import { runMonitorTick } from "@/server/monitor/tick";
import { safeContext } from "@/server/request";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { tokenBySymbol } from "@/server/chain/config";
import type { Hex, LoanPosition } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { deleteRule, rulePanel, saveRule } from "./index";
import { ruleNote } from "./copy";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const LOAN_ID = `8453:${MOCK_SAFE.toLowerCase()}:aave-v3`;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const t0 = new Date("2026-01-01T00:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;

/** 2 ETH at `price` against 2500 USDC, threshold 0.83: price 3000 is health 1.99, price 1800 is 1.195 (below the default At-risk 1.25). */
const position = (price: number): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: LOAN_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 2 * price }],
  debt: [{ asset: "USDC", token: tokenBySymbol(8453, "USDC")!.address!, amount: 2500, usd: 2500 }],
  healthFactor: (2 * price * 0.83) / 2500, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_000n,
});
const setPrice = (price: number) => {
  w.services.fixture.setPosition(8453, SAFE, position(price));
  w.services.fixture.setPrices({ ETH: price, WETH: price });
};
const tick = (min: number) => runMonitorTick({ db: w.db, reader: w.services.reader, services: w.services, now: at(min), log: () => {} });
/** Healthy, then the drop that crosses. */
const crossing = async () => { setPrice(3000); await tick(0); setPrice(1800); await tick(5); };
const activityTexts = async () => (await w.db.select().from(activity)).map((r) => r.text);

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await w.services.fakes.get(8453)!.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
  setPrice(3000);
  w.services.fixture.setBalances(8453, SAFE, { ETH: 5, wstETH: 0, USDC: 0 });
});
afterEach(() => w.reset());

describe("BP-25 the rule is stored once per loan and every change is in Activity (G3)", () => {
  it("creates, edits and deletes one rule per loan, writing an Activity row each time", async () => {
    await saveRule(ctx, LOAN_ID, { option: "coll", enabled: true });
    await saveRule(ctx, LOAN_ID, { option: "repay", enabled: true });
    const panel = await rulePanel(ctx);
    expect(panel.loans).toHaveLength(1);
    expect(panel.loans[0].rule).toMatchObject({ option: "repay", enabled: true });
    await saveRule(ctx, LOAN_ID, { option: "repay", enabled: false });
    await deleteRule(ctx, LOAN_ID);
    expect((await rulePanel(ctx)).loans[0].rule).toBeNull();
    const rows = (await w.db.select().from(activity)).filter((r) => r.actor === "You");
    expect(rows.map((r) => r.text)).toEqual([
      expect.stringMatching(/^Set a standing rule for Aave v3: add collateral/),
      expect.stringMatching(/^Changed the standing rule for Aave v3: repay/),
      expect.stringMatching(/^Turned off the standing rule for Aave v3/),
      expect.stringMatching(/^Deleted the standing rule for Aave v3/),
    ]);
  });

  it("refuses a loan that is not this Safe's, and a bad option", async () => {
    await expect(saveRule(ctx, "8453:0x0000000000000000000000000000000000000001:aave-v3", { option: "coll", enabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(saveRule(ctx, LOAN_ID, { option: "nope" as "coll", enabled: true })).rejects.toMatchObject({ status: 400 });
  });

  it("deleting a rule that is not there is a 404 and writes nothing", async () => {
    await expect(deleteRule(ctx, LOAN_ID)).rejects.toMatchObject({ status: 404 });
    expect(await w.db.select().from(activity)).toHaveLength(0);
  });
});

describe("BP-25 a crossing with the rule on", () => {
  it("drafts the chosen fix, creates no proposal and sends nothing to the Safe service until the owner sends", async () => {
    await saveRule(ctx, LOAN_ID, { option: "coll", enabled: true });
    const fake = w.services.fakes.get(8453)!;
    const posted = vi.spyOn(fake, "proposeTransaction");
    await crossing();
    const [alert] = await w.db.select().from(alerts);
    const [d] = await w.db.select().from(fixDrafts);
    expect(d).toMatchObject({ loanId: LOAN_ID, option: "coll", state: "draft", proposalId: null, canSend: true });
    expect((d.spec as { kind: string; addColl: number }).kind).toBe("protect");
    expect((d.spec as { addColl: number }).addColl).toBeGreaterThan(0);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    expect(posted).not.toHaveBeenCalled();

    const view = await alertView(ctx, alert.id);
    expect(view.rule?.outcome).toBe("drafted");
    expect(view.rule?.line).toMatch(/standing rule drafted this fix/i);
    expect(view.rule?.line).toMatch(/until you press Send to Safe/);
    const [m] = await w.db.select().from(messages);
    expect(JSON.stringify(m)).toContain("standing rule");
    expect(await activityTexts()).toContain(view.rule!.line);

    // The owner's press (the existing fix send path) is what queues it.
    const sent = await sendFix(ctx, d.id);
    expect(sent.stage).toBe("queued");
    expect(await w.db.select().from(proposals)).toHaveLength(1);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("a failed Test run leaves the owner's existing draft untouched and drafts nothing new", async () => {
    await saveRule(ctx, LOAN_ID, { option: "coll", enabled: true });
    setPrice(1800);
    const mine = await draftFix(ctx, { loanId: LOAN_ID, option: "repay" }).catch(() => null);
    const first = mine ?? await draftFix(ctx, { loanId: LOAN_ID, option: "coll" });
    const real = w.services.testRunDeps!.simulate;
    w.services.testRunDeps!.simulate = async () => ({ ok: false, failedStep: 0, healthAfter: null, totalCollateralBase: 0n, totalDebtBase: 0n, gasUsed: 0n, feeUsd: 0.02 });
    setPrice(3000); await tick(0); setPrice(1800); await tick(5);
    w.services.testRunDeps!.simulate = real;
    const rows = await w.db.select().from(fixDrafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, state: "draft" });
    const [alert] = await w.db.select().from(alerts);
    expect((await alertView(ctx, alert.id)).rule?.outcome).toBe("nothing");
  });

  it("runs once per alert: another delivery or tick does not draft again", async () => {
    await saveRule(ctx, LOAN_ID, { option: "coll", enabled: true });
    await crossing();
    await db_resetChat();
    await deliverAlerts({ db: w.db, reader: w.services.reader, services: w.services, now: at(6), log: () => {} });
    await tick(7);
    expect(await w.db.select().from(fixDrafts)).toHaveLength(1);
    expect(await w.db.select().from(ruleRuns)).toHaveLength(1);
  });

  it("the Safe lacks the funds: nothing is drafted and the alert says why", async () => {
    await saveRule(ctx, LOAN_ID, { option: "repay", enabled: true });
    await crossing();
    expect(await w.db.select().from(fixDrafts)).toHaveLength(0);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    const [alert] = await w.db.select().from(alerts);
    const view = await alertView(ctx, alert.id);
    expect(view.rule?.outcome).toBe("nothing");
    expect(view.rule?.line).toMatch(/Needs [\d,]+ USDC\. Your Safe has 0 USDC\./);
    expect(view.rule?.line).toMatch(/nothing was drafted/i);
  });

  it("with enough stablecoin the repay rule drafts the repay", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0, wstETH: 0, USDC: 9000 });
    await saveRule(ctx, LOAN_ID, { option: "repay", enabled: true });
    await crossing();
    const [d] = await w.db.select().from(fixDrafts);
    expect((d.spec as { repay: number }).repay).toBeGreaterThan(0);
    expect(d.state).toBe("draft");
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it("a rule that is off does nothing and the alert carries no rule line", async () => {
    await saveRule(ctx, LOAN_ID, { option: "coll", enabled: false });
    await crossing();
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    const [alert] = await w.db.select().from(alerts);
    expect((await alertView(ctx, alert.id)).rule).toBeNull();
  });

  it("no rule: the existing alert flow is unchanged", async () => {
    await crossing();
    expect(await w.db.select().from(alerts)).toHaveLength(1);
    expect(await w.db.select().from(ruleRuns)).toHaveLength(0);
  });

  it("the rule never acts for someone who no longer owns the Safe (G4)", async () => {
    await saveRule(ctx, LOAN_ID, { option: "coll", enabled: true });
    w.services.fixture.setOwners(8453, SAFE, ["0x0000000000000000000000000000000000000009"]);
    await crossing();
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    const [r] = await w.db.select().from(ruleRuns);
    expect(r.outcome).toBe("nothing");
  });
});

async function db_resetChat() {
  await w.db.update(alerts).set({ chatPostedAt: null });
}

describe("BP-25 Settings states the rule's effect", () => {
  it("has the four rule-note states", () => {
    const base = { lender: "Aave v3", option: "repay" as const, agentActive: true, enabled: true, belowNow: false };
    expect(ruleNote({ ...base, agentActive: false })).toMatch(/not added to this Safe/);
    expect(ruleNote({ ...base, enabled: false })).toMatch(/^Off\. /);
    expect(ruleNote(base)).toMatch(/^On\. .*drafts a repayment.*Nothing is sent to your Safe until you press Send to Safe, and you still sign in Safe\./);
    expect(ruleNote({ ...base, belowNow: true })).toMatch(/already below it, so the rule starts with the next drop\./);
    expect(ruleNote({ ...base, option: "coll" })).toMatch(/adding collateral/);
    expect(ruleNote(base)).toMatch(/does nothing and the alert says why/);
  });

  it("the panel data carries the note for each loan", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 5, wstETH: 0, USDC: 0 });
    await saveRule(ctx, LOAN_ID, { option: "coll", enabled: true });
    const [l] = (await rulePanel(ctx)).loans;
    expect(l.note).toMatch(/^On\. /);
    expect(l.lender).toBe("Aave v3");
  });
});
