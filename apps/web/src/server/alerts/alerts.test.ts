import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { alertTitle } from "@/lib/loan-copy";
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { activity, alertDeliveries, alertState, alerts, monitorStatus, emailPrefs, loanLevels, messages, safeNetworks, safes, snapshots, users } from "@/server/db/schema";
import { COMET_USDC_BASE, MORPHO_WETH_USDC_ID } from "@/server/lenders/allowlist";
import type { AdapterPosition, MarketRef } from "@/server/lenders/types";
import { createFixtureLenders, type FixtureLenders } from "@/server/lenders/fixture";
import { createTestDb, type Db } from "@/server/db/test-db";
import { DevEmailProvider } from "@/server/email/provider";
import { saveEmailSettings, unsubscribeByToken } from "@/server/email/prefs";
import { runMonitorTick } from "@/server/monitor/tick";
import type { SafeContext } from "@/server/request";
import type { Address, LoanPosition } from "@/shared/types";
import { alertView } from "./view";
import { alertCause } from "./cause";
import { deliverAlerts } from "./deliver";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const OWNER2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const LOAN_ID = `8453:${SAFE.toLowerCase()}:aave-v3`;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const t0 = new Date("2026-01-01T00:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const quiet = () => {};

/** 2 ETH at `price` against `debt` USDC. Health is price * 2 * 0.83 / debt. */
const position = (price: number, debt = 5000): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: LOAN_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 2 * price }],
  debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
  healthFactor: (2 * price * 0.83) / debt, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_001n,
});

let db: Db;
let reader: FixtureReader;
let lenders: FixtureLenders;
let safeId: number;
let provider: DevEmailProvider;
let ownerId: number;

const tick = (min: number, price: number, debt?: number) => {
  reader.setPosition(8453, SAFE, position(price, debt));
  return runMonitorTick({ db, lenders, reader, now: at(min), log: quiet, email: provider });
};
const rows = () => db.select().from(alerts).orderBy(alerts.id);

beforeEach(async () => {
  db = await createTestDb();
  reader = createFixtureReader();
  lenders = createFixtureLenders();
  provider = new DevEmailProvider();
  [{ id: safeId }] = await db.insert(safes).values({ address: SAFE.toLowerCase(), name: "Main" }).returning();
  await db.insert(safeNetworks).values({ safeId, chainId: 8453, deployed: true, agentAdded: true });
  reader.setBalances(8453, SAFE, { ETH: 1, USDC: 20000 });
  [{ id: ownerId }] = await db.insert(users).values({ address: OWNER.toLowerCase(), email: "owner@example.com" }).returning();
  reader.setOwners(8453, SAFE, [OWNER, OWNER2]);
});

describe("BP-20 crossing", () => {
  // Health = price * 2 * 0.83 / 2500: 3000 is 1.99, 1800 is 1.195 (below the default At-risk level 1.25), 2000 is 1.33 (Watch only).
  it("posts one alert when health newly falls below the At-risk level, with the cause from snapshots", async () => {
    await tick(0, 3000, 2500); // hf 1.99
    await tick(120, 2850, 2500); // hf 1.89
    expect(await rows()).toHaveLength(0);
    await tick(240, 1800, 2500); // hf 1.195 < 1.25
    const [a] = await rows();
    expect(a).toMatchObject({ safeId, loanId: LOAN_ID, resolvedAt: null });
    expect(a.hf).toBeCloseTo(1.195, 3);
    expect(a.cause).toBe("ETH fell 40% in 4h.");
    const thread = await db.select().from(messages).where(eq(messages.safeId, safeId));
    expect(thread).toHaveLength(1);
    expect(JSON.stringify(thread[0].message)).toContain(`"alertId":${a.id}`);
    const acts = await db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(acts.filter((r) => r.text.includes(alertTitle("Aave v3", a.hf)))).toHaveLength(1); // G3
  });

  const setRate = (apr: number) => {
    const m = [...reader.state.markets.values()].find((x) => x.asset.toLowerCase() === USDC.toLowerCase())!;
    reader.setMarket(8453, { ...m, variableBorrowApr: apr });
  };

  it("E4 #16: debt growing alone is not 'the rate rose' (a new borrow or ordinary interest), the cause is none", async () => {
    setRate(0.04);
    await tick(0, 3000, 2500);
    await tick(60, 3000, 2500 * 1.7); // hf 1.17, same stored rate
    const snaps = await db.select().from(snapshots).orderBy(snapshots.id);
    expect(snaps.map((x) => x.rate)).toEqual(["0.04", "0.04"]);
    expect((await rows())[0].cause).toBeNull();
  });

  it("E4 #16: says the rate rose only when the stored borrow rate rose between snapshots", async () => {
    setRate(0.04);
    await tick(0, 3000, 2500);
    setRate(0.09);
    await tick(60, 3000, 2500 * 1.7);
    expect((await rows())[0].cause).toBe("The rate rose.");
    expect(alertCause("ETH", [{ at: t0, price: 3000, debt: 2500, rate: 0.04 }, { at: at(30), price: 3000, debt: 2500, rate: 0.04 }], at(30))).toBeNull();
    expect(alertCause("ETH", [{ at: t0, price: 3000, debt: 2500, rate: null }, { at: at(30), price: 3000, debt: 4000, rate: 0.09 }], at(30))).toBeNull();
  });

  it("states no cause when the snapshots show none", () => {
    expect(alertCause("ETH", [{ at: t0, price: 3000, debt: 2500 }], at(5))).toBeNull();
    expect(alertCause("ETH", [{ at: t0, price: 3000, debt: 2500 }, { at: at(5), price: 3000, debt: 2500 }], at(5))).toBeNull();
    expect(alertCause("ETH", [{ at: t0, price: 3000, debt: 2500 }, { at: at(30), price: 2850, debt: 2500 }], at(30))).toBe("ETH fell 5% in 30 min.");
  });

  it("posts no second alert while the loan stays below the level", async () => {
    await tick(0, 3000, 2500);
    await tick(60, 1800, 2500);
    await tick(120, 1900, 2500);
    await tick(180, 1800, 2500);
    expect(await rows()).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it("does not alert from Watch down: only the saved At-risk level counts, and a saved level is honoured", async () => {
    await tick(0, 3000, 2500);
    await tick(60, 2500, 2500); // hf 1.66 healthy
    await tick(120, 2000, 2500); // hf 1.33 watch
    expect(await rows()).toHaveLength(0);
    await db.insert(loanLevels).values({ safeId, loanId: LOAN_ID, chainId: 8453, warn: 1.8, act: 1.6 });
    await tick(180, 2000, 2500); // hf 1.33 < 1.6
    expect(await rows()).toHaveLength(1);
  });

  it("a new alert after it recovered to the Watch level and crossed again; the older one is tagged Newer alert below", async () => {
    await tick(0, 3000, 2500);
    await tick(60, 1800, 2500); // alert 1
    await tick(120, 2000, 2500); // hf 1.33: watch, not recovered
    await tick(180, 1800, 2500); // still the same crossing
    expect(await rows()).toHaveLength(1);
    await tick(240, 3000, 2500); // hf 1.99 >= 1.45: resolved
    const [first] = await rows();
    expect(first.resolvedAt).toEqual(at(240));
    await tick(300, 1700, 2500);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(await db.select().from(messages)).toHaveLength(2);
    const ctx = viewCtx();
    expect((await alertView(ctx, all[0].id)).state).toBe("replaced");
    expect((await alertView(ctx, all[0].id)).tag).toBe("Newer alert below");
    expect((await alertView(ctx, all[1].id)).state).toBe("live");
  });

  it("reads Resolved once health is back at the Watch level", async () => {
    await tick(0, 3000, 2500);
    await tick(60, 1800, 2500);
    const [a] = await rows();
    reader.setPosition(8453, SAFE, position(1800, 2500));
    expect((await alertView(viewCtx(), a.id)).state).toBe("live");
    reader.setPosition(8453, SAFE, position(2900, 2500)); // hf 1.93
    const v = await alertView(viewCtx(), a.id);
    expect(v).toMatchObject({ state: "resolved", tag: "Resolved" });
  });

  it("the live view has the title, options in r15 order and a cushion line from app data", async () => {
    await tick(0, 3000, 2500);
    await tick(240, 1800, 2500);
    const [a] = await rows();
    const v = await alertView(viewCtx(), a.id);
    expect(v).toMatchObject({ lender: "aave-v3", reserveEligibility: { eligible: true, reason: null } });
    expect(v.title).toBe(alertTitle("Aave v3", a.hf));
    expect(v.options.length).toBe(3);
    expect(v.options.filter((o) => o.recommended).length).toBeLessThanOrEqual(1);
    expect(v.options.every((o) => o.hf >= DEFAULT_LEVELS.warn || o.short)).toBe(true);
    expect(v.cause).toBe("ETH fell 40% in 4h.");
    expect(v.cushion).toMatch(/ETH can fall/);
  });

  it("keeps health alerts when a token price is unavailable without estimating fixes", async () => {
    const unpriced = position(1800, 2500);
    unpriced.healthFactor = 1.2;
    unpriced.collateral[0].usd = null;
    reader.setPosition(8453, SAFE, unpriced);
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet, email: provider });
    const [alert] = await rows();
    const view = await alertView(viewCtx(), alert.id);
    expect(view).toMatchObject({ hf: 1.2, cushion: null, options: [] });
    expect(view.note).toMatch(/fix amounts are not estimated because the loan has mixed assets or a token price is unavailable/i);
  });

  it("an alert is written before it is delivered: a failed chat post leaves it pending and the next tick delivers it once", async () => {
    await tick(0, 3000, 2500);
    // the alert row exists without a chat message until delivery runs
    const { onSnapshot } = await import("./crossing");
    reader.setPosition(8453, SAFE, position(1800, 2500));
    await db.insert(snapshots).values({ safeId, chainId: 8453, loanId: LOAN_ID, at: at(10), blockNumber: 1n, health: "1.195", price: "1800", debt: "2500", collateral: "4000" });
    await onSnapshot({ db, reader, now: at(10), log: quiet, email: provider, skipDelivery: true }, { safeId, position: position(1800, 2500) });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].chatPostedAt).toBeNull();
    expect(await db.select().from(messages)).toHaveLength(0);
    await deliverAlerts({ db, reader, now: at(11), log: quiet, email: provider });
    await deliverAlerts({ db, reader, now: at(12), log: quiet, email: provider });
    expect(await db.select().from(messages)).toHaveLength(1);
  });
});

const viewCtx = () => ({
  db, services: { reader }, safe: { id: safeId, address: SAFE.toLowerCase(), name: "Main" },
  networks: [{ safeId, chainId: 8453, deployed: true, agentAdded: true }],
  access: { ownedChainIds: [8453], trackedChainIds: [8453], chat: true, ownersDiffer: false },
}) as unknown as SafeContext;

describe("Watch message", () => {
  // Health = price * 2 * 0.83 / 1660 = price / 1000. Default levels come from DEFAULT_LEVELS (Watch 1.45, At-risk 1.25); the helpers below are offsets from them.
  const W = DEFAULT_LEVELS.warn;
  const A = DEFAULT_LEVELS.act;
  const band = W - 0.1; // inside the Watch band
  const hover = (d: number) => Math.round((W + d) * 1000) / 1000;
  const watchTick = (min: number, hf: number) => tick(min, hf * 1000, 1660);
  const watchMsgs = async () => (await db.select().from(messages).where(eq(messages.safeId, safeId))).filter((m) => m.id.startsWith("watch-"));
  const watchActs = async () => (await db.select().from(activity).where(eq(activity.safeId, safeId))).filter((a) => /below your Watch level/.test(a.text));

  it("falling into the Watch band posts one plain chat message and one Activity row, no alert and no email", async () => {
    await watchTick(0, 2.0);
    await watchTick(1, band);
    const msgs = await watchMsgs();
    expect(msgs).toHaveLength(1);
    expect((msgs[0].message as { parts: unknown[] }).parts).toEqual([{ type: "text", text: `Aave v3 loan is below your Watch level (health ${band.toFixed(2)}). Nothing to do yet. If it falls to your At-risk level of ${A}, I'll alert you and email the owners.` }]);
    expect(await watchActs()).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
    expect(await db.select().from(alertDeliveries)).toHaveLength(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("stays quiet on later snapshots in the band", async () => {
    await watchTick(0, 2.0);
    await watchTick(1, band);
    await watchTick(2, A + 0.05);
    await watchTick(3, band);
    expect(await watchMsgs()).toHaveLength(1);
  });

  it("does not repeat when health hovers at the Watch level", async () => {
    await watchTick(0, 2.0);
    await watchTick(1, band);
    await watchTick(2, W);
    await watchTick(3, hover(-0.02));
    await watchTick(4, hover(0.02));
    await watchTick(5, hover(-0.01));
    expect(await watchMsgs()).toHaveLength(1);
  });

  it("posts again after health recovered past the margin and fell again", async () => {
    await watchTick(0, 2.0);
    await watchTick(1, band);
    await watchTick(2, W + 0.1);
    await watchTick(3, band);
    expect(await watchMsgs()).toHaveLength(2);
    expect(await watchActs()).toHaveLength(2);
  });

  it("falling straight below At-risk alerts only; recovering into the band posts no Watch message", async () => {
    await watchTick(0, 2.0);
    await watchTick(1, A - 0.05);
    expect(await rows()).toHaveLength(1);
    expect(await watchMsgs()).toHaveLength(0);
    await watchTick(2, band); // still crossed: At-risk until Watch is regained
    await watchTick(3, hover(0.02)); // alert resolves, short of the re-arm margin
    await watchTick(4, band);
    expect(await watchMsgs()).toHaveLength(0);
    await watchTick(5, W + 0.1);
    await watchTick(6, band);
    expect(await watchMsgs()).toHaveLength(1);
  });

  it("recovering exactly to Watch plus the margin re-arms", async () => {
    await watchTick(0, 2.0);
    await watchTick(1, band);
    await watchTick(2, hover(0.05));
    await watchTick(3, band);
    expect(await watchMsgs()).toHaveLength(2);
  });

  it("a closed loan re-arms the message", async () => {
    await watchTick(0, 2.0);
    await watchTick(1, band);
    reader.setPosition(8453, SAFE, null);
    await runMonitorTick({ db, lenders, reader, now: at(2), log: quiet, email: provider });
    await watchTick(3, band);
    expect(await watchMsgs()).toHaveLength(2);
  });
});

describe("BP-21 email", () => {
  const crossIt = async () => { await tick(0, 3000, 2500); await tick(60, 1800, 2500); };

  it("emails each owner who gave an address, with the loan, status and a link, and no figure", async () => {
    const [two] = await db.insert(users).values({ address: OWNER2.toLowerCase(), email: "two@example.com" }).returning();
    expect(two.id).toBeGreaterThan(0);
    await crossIt();
    expect(provider.sent.map((m) => m.to).sort()).toEqual(["owner@example.com", "two@example.com"]);
    const [a] = await rows();
    const m = provider.sent[0];
    expect(m.subject).toBe(`${alertTitle("Aave v3", a.hf)} · Main`);
    expect(m.text).toContain("Aave v3");
    expect(m.text).toContain("Base");
    expect(m.text).toContain("Below your At-risk level.");
    expect(m.text).toContain(`/s/${SAFE.toLowerCase()}/chat?alert=${a.id}`);
    expect(m.text).toContain("/api/alerts/unsubscribe?token=");
    const body = m.text.replace(/https?:\/\/\S+/g, "").replace(/0x[0-9a-f]+(…[0-9a-f]+)?/gi, "").replaceAll("Aave v3", "Aave");
    expect(body).not.toMatch(/\d/); // no figure at all: the app shows them, the email does not
  });

  it("an unnamed Safe is called by its short address, never by an empty name", async () => {
    await db.update(safes).set({ name: "" }).where(eq(safes.id, safeId));
    await crossIt();
    const m = provider.sent[0];
    expect(m.subject).toMatch(/ · 0x5afe…0001$/i);
    expect(m.text).toMatch(/^0x5afe…0001/i);
    expect(m.text.startsWith(":")).toBe(false);
    expect(m.text.split("\n")[0]).not.toMatch(/^:/);
  });

  it("sends nothing to an owner without an address, a non-owner, or at a level above At-risk", async () => {
    await db.insert(users).values({ address: OWNER2.toLowerCase() }); // no email
    await db.insert(users).values({ address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906".toLowerCase(), email: "stranger@example.com" });
    await tick(0, 3000, 2500);
    await tick(60, 2000, 2500); // watch only
    expect(provider.sent).toHaveLength(0);
    await tick(120, 1800, 2500);
    expect(provider.sent.map((m) => m.to)).toEqual(["owner@example.com"]);
  });

  it("sends none once the owner turned email off, and the unsubscribe link does it", async () => {
    await saveEmailSettings(db, ownerId, { enabled: false });
    await crossIt();
    expect(provider.sent).toHaveLength(0);
  });

  it("the unsubscribe token turns email off for its owner only", async () => {
    const [two] = await db.insert(users).values({ address: OWNER2.toLowerCase(), email: "two@example.com" }).returning();
    await crossIt();
    const text = provider.sent.find((m) => m.to === "owner@example.com")!.text;
    const token = /token=([0-9a-f]+)/.exec(text)![1];
    expect(await unsubscribeByToken(db, "nope")).toBe(false);
    expect(await unsubscribeByToken(db, token)).toBe(true);
    const prefs = await db.select().from(emailPrefs);
    expect(prefs.find((p) => p.userId === ownerId)?.enabled).toBe(false);
    expect(prefs.find((p) => p.userId === two.id)?.enabled ?? true).toBe(true);
  });

  it("retries a failed provider, logs the failure, and sends once", async () => {
    const logs: string[] = [];
    provider.failNext = 2;
    reader.setPosition(8453, SAFE, position(3000, 2500));
    const run = (min: number, price: number) => { reader.setPosition(8453, SAFE, position(price, 2500)); return runMonitorTick({ db, lenders, reader, now: at(min), log: (m) => logs.push(m), email: provider }); };
    await run(0, 3000);
    await run(1, 1800); // crossing; first send fails
    expect(provider.sent).toHaveLength(0);
    expect(logs.some((l) => /email/i.test(l))).toBe(true);
    let [d] = await db.select().from(alertDeliveries);
    expect(d).toMatchObject({ status: "pending", attempts: 1 });
    expect(d.lastError).toMatch(/scripted failure/);
    await run(2, 1800); // backoff not over
    expect(provider.sent).toHaveLength(0);
    await run(3, 1800); // second attempt fails
    await run(10, 1800); // third succeeds
    expect(provider.sent).toHaveLength(1);
    [d] = await db.select().from(alertDeliveries);
    expect(d).toMatchObject({ status: "sent", attempts: 3 });
    await run(20, 1800);
    expect(provider.sent).toHaveLength(1);
  });

  it("gives up after the last attempt, with an Activity row", async () => {
    provider.failNext = 99;
    await tick(0, 3000, 2500);
    await tick(1, 1800, 2500);
    for (let i = 1; i <= 8; i++) await tick(1 + i * 60, 1800, 2500);
    const [d] = await db.select().from(alertDeliveries);
    expect(d.status).toBe("failed");
    const acts = await db.select().from(activity);
    expect(acts.some((r) => /could not email/i.test(r.text))).toBe(true);
  });

  it("the per-alert key stops a retry from sending twice", async () => {
    const m = { to: "a@example.com", subject: "s", text: "t", idempotencyKey: "alert:1:user:1" };
    await provider.send(m);
    await provider.send(m);
    expect(provider.sent).toHaveLength(1);
  });
});

describe("E4 #4a/#12 every lender, and a loan that disappears", () => {
  const COMET = { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" } as const;
  const MORPHO = { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC_ID, collateral: "WETH" } as const;
  const adapterPos = (ref: MarketRef, price: number, debt: number): AdapterPosition => ({
    lender: ref.lender, chainId: 8453, safe: SAFE, marketId: ref.marketId,
    collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 2 * price }], debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
    health: (2 * price * 0.85) / debt, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 57_172_001n,
  });
  const run = (min: number) => runMonitorTick({ db, lenders, reader, now: at(min), log: quiet, email: provider });

  for (const ref of [COMET, MORPHO]) {
    it(`${ref.lender}: snapshots with its own health and alerts once on crossing, titled with the lender`, async () => {
      const id = `8453:${SAFE.toLowerCase()}:${ref.lender}`;
      lenders.setPosition(ref, SAFE, adapterPos(ref, 3000, 2500)); // hf 2.04
      await run(0);
      lenders.setPosition(ref, SAFE, adapterPos(ref, 2000, 2500)); // hf 1.36 > 1.25
      await run(1);
      lenders.setPosition(ref, SAFE, adapterPos(ref, 1800, 2500)); // hf 1.224
      await run(2);
      await run(3);
      const snaps = await db.select().from(snapshots).where(eq(snapshots.loanId, id)).orderBy(snapshots.id);
      expect(snaps.map((s) => Number(Number(s.health).toFixed(2)))).toEqual([2.04, 1.36, 1.22, 1.22]);
      expect(snaps[0].rate).not.toBeNull();
      const a = await rows();
      expect(a).toHaveLength(1);
      expect(a[0].loanId).toBe(id);
      const [m] = await db.select().from(messages);
      expect(JSON.stringify(m.message)).toContain(ref.lender === "morpho-blue" ? "Morpho" : "Compound v3");
      expect(provider.sent).toHaveLength(1);
      const [st] = await db.select().from(monitorStatus);
      expect(st.loanCount).toBe(1);
    });
  }

  it("a committed alert that was never posted is delivered even when the loan has disappeared", async () => {
    await tick(0, 3000, 2500);
    await tick(1, 2000, 2500 * 1.1);
    await tick(2, 1500, 2500 * 1.1);
    await db.delete(messages);
    await db.update(alerts).set({ chatPostedAt: null, emailPlannedAt: null });
    await db.delete(alertDeliveries);
    reader.setPosition(8453, SAFE, null);
    await runMonitorTick({ db, lenders, reader, now: at(3), log: quiet, email: provider });
    const [a] = await rows();
    expect(a.chatPostedAt).not.toBeNull();
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(provider.sent.length).toBeGreaterThan(0);
  });

  it("a closed loan resolves its crossing state and alert; a lender that failed to read does not", async () => {
    await tick(0, 3000, 2500);
    await tick(1, 1500, 2500);
    const [crossed] = await db.select().from(alertState);
    expect(crossed.crossed).toBe(true);
    // The read fails: nothing is known, so the state stays.
    await runMonitorTick({ db, lenders, reader: { ...reader, readAavePosition: () => Promise.reject(new Error("rpc down")) } as typeof reader, now: at(2), log: quiet, email: provider }).catch(() => {});
    expect((await db.select().from(alertState))[0].crossed).toBe(true);
    reader.setPosition(8453, SAFE, null);
    await runMonitorTick({ db, lenders, reader, now: at(3), log: quiet, email: provider });
    expect((await db.select().from(alertState))[0].crossed).toBe(false);
    expect((await rows())[0].resolvedAt).toEqual(at(3));
    const acts = await db.select().from(activity);
    expect(acts.some((r) => /closed/i.test(r.text))).toBe(true);
    // It crosses again as a new loan would.
    await tick(4, 3000, 2500);
    await tick(5, 1500, 2500);
    expect(await rows()).toHaveLength(2);
  });
});
