import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { schema, type Db } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import { loadThread } from "@/server/agent/persist";
import { listActivity } from "@/server/activity";
import { MOCK_EMPTY_SAFE, MOCK_OWNER } from "@/server/mock/seed";
import { depositJob, DEPOSIT_POLL_MS, pollDeposits } from "./poll";

let db: Db;
let reader: FixtureReader;
let safeId: number;
const now = new Date("2026-01-01T00:00:00Z");
const run = () => pollDeposits({ db, reader, now, log: () => {} });
const texts = async () => (await loadThread(db, safeId)).map((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type === "data-block" ? JSON.stringify(p.data) : "")).join(" "));

beforeEach(async () => {
  db = await createTestDb();
  reader = createFixtureReader();
  reader.setOwners(8453, MOCK_EMPTY_SAFE, [MOCK_OWNER], 1);
  reader.setBalances(8453, MOCK_EMPTY_SAFE, {});
  const [s] = await db.insert(schema.safes).values({ address: MOCK_EMPTY_SAFE.toLowerCase(), name: "Main Safe" }).returning();
  safeId = s.id;
  await db.insert(schema.safeNetworks).values({ safeId, chainId: 8453, deployed: true });
});

describe("deposit job", () => {
  it("polls once a minute", () => {
    expect(DEPOSIT_POLL_MS).toBe(60_000);
    expect(depositJob.intervalMs).toBe(DEPOSIT_POLL_MS);
  });

  it("a rise gives one deposit, one Activity row and one chat message with one chip; polling again adds nothing", async () => {
    await run(); // baseline on an empty Safe
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await run();
    await run();
    const deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ asset: "ETH", chainId: 8453, amount: "5" });
    expect(deps[0].announcedAt).not.toBeNull();
    const act = await listActivity(db, safeId);
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ actor: "Agent", kind: "status", chainId: 8453 });
    expect(act[0].text).toContain("5 ETH");
    const msgs = await texts();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("I see 5 ETH (about $15,000) on Base in Main Safe. You can borrow up to $");
    expect(msgs[0]).toContain('"kind":"suggestions"');
    expect(msgs[0].match(/Borrow \$/g)).toHaveLength(1);
  });

  it("deposit message offers no Borrow chip while a loan is at risk, and still does when healthy", async () => {
    const pos = (hf: number) => ({
      chainId: 8453, safe: MOCK_EMPTY_SAFE, lender: "aave-v3", id: `8453:${MOCK_EMPTY_SAFE.toLowerCase()}:aave-v3`,
      collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
      healthFactor: hf, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n,
    }) as never;
    await run();
    reader.setPosition(8453, MOCK_EMPTY_SAFE, pos(1.2));
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await run();
    let msgs = await texts();
    expect(msgs[0]).toContain("I see 5 ETH (about $15,000) on Base in Main Safe.");
    expect(msgs[0]).not.toMatch(/Borrow \$|suggestions|borrow up to/i);
    reader.setPosition(8453, MOCK_EMPTY_SAFE, pos(2.4));
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 10 });
    await run();
    msgs = await texts();
    expect(msgs[1]).toMatch(/Borrow \$/);
  });

  it("too little to borrow against: says so and offers no chip", async () => {
    await run();
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 0.001 });
    await run();
    const msgs = await texts();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("I see 0.001 ETH (about $3) on Base in Main Safe. That is not enough to borrow against yet.");
    expect(msgs[0]).not.toContain("suggestions");
  });

  it("funds on a network where the Safe is not set up yet are recorded and shown", async () => {
    await db.insert(schema.safeNetworks).values({ safeId, chainId: 42161, deployed: false });
    await run();
    reader.setBalances(42161, MOCK_EMPTY_SAFE, { ETH: 1 });
    await run();
    const deps = await db.select().from(schema.deposits).where(eq(schema.deposits.chainId, 42161));
    expect(deps).toHaveLength(1);
    expect((await listActivity(db, safeId))[0].chainId).toBe(42161);
    expect((await texts())[0]).toContain("1 ETH");
  });

  it("a failed read on one network does not stop the others, and the tick fails", async () => {
    await db.insert(schema.safeNetworks).values({ safeId, chainId: 42161, deployed: false });
    await run();
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    const orig = reader.readBalances;
    reader.readBalances = async (c, s) => { if (c === 42161) throw new Error("rpc down"); return orig(c, s); };
    await expect(run()).rejects.toThrow("rpc down");
    expect(await db.select().from(schema.deposits)).toHaveLength(1);
  });

  it("an unannounced deposit left by a crash is announced on the next tick, once", async () => {
    await run();
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await run();
    await db.update(schema.deposits).set({ announcedAt: null });
    await run();
    expect(await listActivity(db, safeId)).toHaveLength(1);
    expect(await texts()).toHaveLength(1);
  });

  it("a rise caused by a proposal executed since the last poll is not a deposit; a later real deposit is", async () => {
    await run();
    await db.insert(schema.proposals).values({
      id: "p1", safeId, chainId: 8453, spec: {}, idempotencyKey: "k1", title: "Close loan", steps: [], outcome: "x",
      stage: "executed", updatedAt: new Date(now.getTime() + 1000),
    });
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    const later = new Date(now.getTime() + 60_000);
    await pollDeposits({ db, reader, now: later, log: () => {} });
    expect(await db.select().from(schema.deposits)).toHaveLength(0);
    expect(await listActivity(db, safeId)).toHaveLength(0);
    expect(await texts()).toHaveLength(0);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 7 });
    await pollDeposits({ db, reader, now: new Date(now.getTime() + 120_000), log: () => {} });
    const deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1);
    expect(deps[0].amount).toBe("2");
    expect(await texts()).toHaveLength(1);
  });

  const proposal = (id: string, over: Partial<typeof schema.proposals.$inferInsert>) =>
    db.insert(schema.proposals).values({
      id, safeId, chainId: 8453, spec: { kind: "protect", loanId: "l", addColl: 0, repay: 500 }, idempotencyKey: `k-${id}`, title: "t", steps: ["Repay 500 USDC on Aave v3"], outcome: "x",
      stage: "executed", updatedAt: new Date(now.getTime() + 1000), ...over,
    });
  const later = new Date(now.getTime() + 60_000);

  it("an ETH deposit next to a USDC repay is announced", async () => {
    await run();
    await proposal("p-repay", {});
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await pollDeposits({ db, reader, now: later, log: () => {} });
    const deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1);
    expect(deps[0].asset).toBe("ETH");
  });

  it("only the asset an executed close withdraws is skipped; another asset's rise is announced", async () => {
    await run();
    await proposal("p-close", { spec: { kind: "close", loanId: "l" }, steps: ["Repay 1,000 USDC on Aave v3", "Withdraw 5 ETH"] });
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5, wstETH: 1 });
    await pollDeposits({ db, reader, now: later, log: () => {} });
    const deps = await db.select().from(schema.deposits);
    expect(deps.map((d) => d.asset)).toEqual(["wstETH"]);
  });

  it("a proposal still marked queued that the Safe service shows executed explains its rise; the stage is left alone", async () => {
    await run();
    await proposal("p-q", { spec: { kind: "close", loanId: "l" }, steps: ["Withdraw 5 ETH"], stage: "queued", safeTxHash: "0x" + "ab".repeat(32), updatedAt: new Date(now.getTime() - 1000) });
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    const services = { safeService: () => ({ getMultisigTransaction: async () => ({ isExecuted: true, isSuccessful: true }) }) } as never;
    await pollDeposits({ db, reader, services, now: later, log: () => {} });
    expect(await db.select().from(schema.deposits)).toHaveLength(0);
    const [row] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, "p-q"));
    expect(row.stage).toBe("queued");
  });

  it("a queued proposal the service does not show executed hides nothing", async () => {
    await run();
    await proposal("p-q2", { stage: "queued", safeTxHash: "0x" + "cd".repeat(32), steps: ["Withdraw 5 ETH"], updatedAt: new Date(now.getTime() - 1000) });
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    const services = { safeService: () => ({ getMultisigTransaction: async () => ({ isExecuted: false }) }) } as never;
    await pollDeposits({ db, reader, services, now: later, log: () => {} });
    expect(await db.select().from(schema.deposits)).toHaveLength(1);
  });

  it("a proposal on another network does not hide a deposit", async () => {
    await run();
    await db.insert(schema.proposals).values({
      id: "p2", safeId, chainId: 84532, spec: {}, idempotencyKey: "k2", title: "t", steps: [], outcome: "x",
      stage: "executed", updatedAt: new Date(now.getTime() + 1000),
    });
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await pollDeposits({ db, reader, now: new Date(now.getTime() + 60_000), log: () => {} });
    expect(await db.select().from(schema.deposits)).toHaveLength(1);
  });

  describe("first poll of a Safe", () => {
    const OLD = new Date("2025-01-01T00:00:00Z");
    it("a Safe added long ago and deployed keeps the silent baseline", async () => {
      await db.update(schema.safes).set({ createdAt: OLD }).where(eq(schema.safes.id, safeId));
      reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
      await run();
      expect(await db.select().from(schema.deposits)).toHaveLength(0);
    });
    it("a Safe added recently announces what it holds on the first poll", async () => {
      await db.update(schema.safes).set({ createdAt: new Date(now.getTime() - 5 * 60_000) }).where(eq(schema.safes.id, safeId));
      reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
      await run();
      expect(await db.select().from(schema.deposits)).toHaveLength(1);
      expect(await texts()).toHaveLength(1);
    });
    it("a Safe not deployed yet announces what it holds on the first poll, however old", async () => {
      await db.update(schema.safes).set({ createdAt: OLD }).where(eq(schema.safes.id, safeId));
      await db.update(schema.safeNetworks).set({ deployed: false }).where(eq(schema.safeNetworks.safeId, safeId));
      reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
      await run();
      expect(await db.select().from(schema.deposits)).toHaveLength(1);
    });
  });
});
