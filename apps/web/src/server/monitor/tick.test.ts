import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import type { ChainReader } from "@/server/chain/types";
import { activity, alertState, alerts, monitorStatus, reserveRuns, safeNetworks, safes, snapshots } from "@/server/db/schema";
import { createFixtureLenders, type FixtureLenders } from "@/server/lenders/fixture";
import { chainLenderReads } from "@/server/lenders/reads";
import { createTestDb, type Db } from "@/server/db/test-db";
import { createFixtureReserveChain } from "@/server/reserve/executor/fixture-chain";
import { setReserveRuntimeForTests } from "@/server/reserve/executor/runtime";
import { linkFingerprint } from "@/server/reserve/executor/store";
import type { ExecLink } from "@/server/reserve/types";
import { createMockServices } from "@/server/services";
import type { Address, ChainId, LoanPosition } from "@/shared/types";
import { saveLink } from "../../../tests/helpers/reserve-setup";
import { MONITOR_INTERVAL_MS, runMonitorTick } from "./tick";
import { monitorStatusFor } from "./status";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const t0 = new Date("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const quiet = () => {};

const position = (chainId: ChainId, over: Partial<LoanPosition> = {}): LoanPosition => ({
  chainId, safe: SAFE, lender: "aave-v3", id: `${chainId}:${SAFE.toLowerCase()}:aave-v3`,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }],
  debt: [{ asset: "USDC", token: USDC, amount: 2000, usd: 2000 }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_001n, ...over,
});

let db: Db;
let reader: FixtureReader;
let lenders: FixtureLenders;
let safeId: number;

beforeEach(async () => {
  db = await createTestDb();
  reader = createFixtureReader();
  lenders = createFixtureLenders();
  [{ id: safeId }] = await db.insert(safes).values({ address: SAFE.toLowerCase(), name: "Main" }).returning();
  await db.insert(safeNetworks).values([
    { safeId, chainId: 8453, deployed: true, agentAdded: true },
    { safeId, chainId: 84532, deployed: true, agentAdded: true },
  ]);
});

const failing = (r: ChainReader, chainId: ChainId): ChainReader => ({
  ...r,
  readAavePosition: (c, s) => (c === chainId ? Promise.reject(new Error("rpc down")) : r.readAavePosition(c, s)),
});

describe("monitor tick (BP-18)", () => {
  it("runs about once a minute by default", () => {
    expect(MONITOR_INTERVAL_MS).toBe(60_000);
  });

  it("uses the service's synthetic lender reads when the monitor caller omits an override", async () => {
    const externalPositionRead = vi.spyOn(chainLenderReads, "position").mockResolvedValue(null);
    const services = createMockServices({ db: async () => db });
    try {
      await runMonitorTick({ db, reader, services, now: t0, log: quiet });
      expect(externalPositionRead).not.toHaveBeenCalled();
    } finally {
      externalPositionRead.mockRestore();
    }
  });

  it("stores one snapshot per loan with the lender's health, block, price, debt and collateral", async () => {
    reader.setPosition(8453, SAFE, position(8453));
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet });
    const rows = await db.select().from(snapshots);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ safeId, chainId: 8453, loanId: `8453:${SAFE.toLowerCase()}:aave-v3`, health: "2.49", debt: "2000", collateral: "6000", price: "3000", blockNumber: 57_172_000n });
    expect(rows[0].at).toEqual(t0);
    await runMonitorTick({ db, lenders, reader, now: at(60_000), log: quiet });
    expect(await db.select().from(snapshots)).toHaveLength(2);
  });

  it("records an At-risk crossing from finite lender health when a position token has no USD price", async () => {
    reader.setPosition(8453, SAFE, position(8453, {
      healthFactor: 1.2,
      collateral: [
        { asset: "WETH", token: WETH, amount: 2, usd: 6000 },
        { asset: "wstETH", token: "0x0000000000000000000000000000000000000011" as Address, amount: 1, usd: null },
      ],
    }));
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet });
    const [alert] = await db.select().from(alerts);
    expect(alert).toMatchObject({ safeId, chainId: 8453, hf: 1.2, price: null, addColl: null, repay: null });
    expect(alert.cause).toBeNull();
    expect(alert.snap).toBeNull(); // mixed position: health alert, no unsupported single-asset estimate
    expect((await db.select().from(alertState))[0]).toMatchObject({ crossed: true });
    expect(await db.select().from(snapshots)).toEqual([]); // no fabricated dollar totals
    expect(await db.select().from(reserveRuns)).toEqual([]); // unknown prices never trigger automatic reserve spending
    expect((await db.select().from(monitorStatus))[0]).toMatchObject({ lastError: null, loanCount: 1 });
  });

  it("skips Safes without the agent and Safes without a loan", async () => {
    await db.update(safeNetworks).set({ agentAdded: false }).where(eq(safeNetworks.chainId, 84532));
    reader.setPosition(84532, SAFE, position(84532));
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet });
    expect(await db.select().from(snapshots)).toHaveLength(0);
    const [s] = await db.select().from(monitorStatus);
    expect(s).toMatchObject({ chainId: 8453, loanCount: 0, lastError: null, source: "Aave v3 on Base" });
  });

  it("recovers committed reserve intent and releases an expired unsubmitted handoff after agent removal", async () => {
    const link: ExecLink = {
      safeId, chainId: 8453, mainSafe: SAFE, reserveSafe: "0x00000000000000000000000000000000000000b2",
      roles: "0x00000000000000000000000000000000000000d4", executor: "0x00000000000000000000000000000000000000e5",
      token: USDC, tokenSymbol: "USDC", tokenDecimals: 6, trigger: 1.3, attempt: 0, active: true, fromBlock: 1n,
    };
    await saveLink(db, link);
    const loan = position(8453, { healthFactor: 1.12, collateral: [{ asset: "WETH", token: WETH, amount: 1, usd: 2700 }] });
    reader.setPosition(8453, SAFE, loan);
    reader.setBalances(8453, link.reserveSafe, { USDC: 500 });
    const chain = createFixtureReserveChain(reader);
    chain.setup(link, { dailyLimitRaw: 500_000_000n, members: [link.executor] });
    const signer = { address: link.executor, signRoleCall: vi.fn() };
    const persistSignedRun = async (nonce: number, broadcastAt: Date | null) => {
      const prepared = await chain.prepare(link, 10_000_000n, nonce, signer);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error(prepared.error);
      await db.insert(reserveRuns).values({
        safeId, chainId: 8453, loanId: loan.id, key: `auto:run:${nonce}`, status: "pending", requestedRaw: "10000000",
        hfBefore: loan.healthFactor, linkFingerprint: linkFingerprint(link), signedTx: prepared.tx.raw, txHash: prepared.tx.hash,
        nonce, executorAddress: link.executor, broadcastAt, leaseExpiresAt: broadcastAt ? null : at(120_000),
      });
      return prepared.tx;
    };
    const committed = await persistSignedRun(0, t0);
    await db.update(safeNetworks).set({ agentAdded: false }).where(eq(safeNetworks.chainId, 8453));
    const deps = { db, lenders, reader, log: quiet, services: createMockServices({ db: async () => db }), email: null };
    setReserveRuntimeForTests({ chain, signer });
    try {
      await runMonitorTick({ ...deps, now: at(60_000) });
      expect(chain.submitted).toEqual([committed]);

      const uncommitted = await persistSignedRun(1, null);
      await runMonitorTick({ ...deps, now: at(119_999) });
      expect(chain.submitted).toEqual([committed]);
      expect(chain.prepared).toEqual([committed, uncommitted]);
      expect(await db.select().from(reserveRuns).orderBy(reserveRuns.id)).toMatchObject([
        { status: "done", txHash: committed.hash },
        { status: "pending", txHash: uncommitted.hash, broadcastAt: null },
      ]);
      expect(await db.select().from(snapshots)).toHaveLength(0);

      const otherSafe = "0x0000000000000000000000000000000000000aa2";
      const [{ id: otherSafeId }] = await db.insert(safes).values({ address: otherSafe, name: "Other" }).returning();
      const otherLink: ExecLink = {
        ...link, safeId: otherSafeId, mainSafe: otherSafe,
        reserveSafe: "0x0000000000000000000000000000000000000bb2", roles: "0x0000000000000000000000000000000000000dd4",
      };
      await saveLink(db, otherLink);
      await db.insert(safeNetworks).values({ safeId: otherSafeId, chainId: 8453, deployed: true, agentAdded: true });
      reader.setPosition(8453, otherSafe, { ...loan, safe: otherSafe, id: `8453:${otherSafe}:aave-v3` });
      reader.setBalances(8453, otherLink.reserveSafe, { USDC: 500 });
      chain.setup(otherLink, { dailyLimitRaw: 500_000_000n, members: [otherLink.executor] });

      await runMonitorTick({ ...deps, now: at(120_000) });
      expect(await db.select().from(reserveRuns).orderBy(reserveRuns.id)).toMatchObject([
        { safeId, status: "done", txHash: committed.hash },
        {
          safeId, status: "failed", txHash: null, signedTx: null, nonce: null, executorAddress: null,
          broadcastAt: null, leaseExpiresAt: null, error: expect.stringMatching(/agent.*removed/i),
        },
        { safeId: otherSafeId, status: "done", nonce: uncommitted.nonce },
      ]);
      expect(chain.submitted).toEqual([committed, expect.objectContaining({ nonce: uncommitted.nonce })]);
      expect(chain.submitted[1]?.hash).not.toBe(uncommitted.hash);
      expect((await db.select().from(snapshots)).map((snapshot) => snapshot.safeId)).toEqual([otherSafeId]);
    } finally {
      setReserveRuntimeForTests(undefined);
    }
  });

  it("a debt-free loan is stored without a figure that cannot be shown", async () => {
    reader.setPosition(8453, SAFE, position(8453, { debt: [], healthFactor: Number.POSITIVE_INFINITY }));
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet });
    const [r] = await db.select().from(snapshots);
    expect(r.debt).toBe("0");
    expect(Number.isFinite(Number(r.health))).toBe(false);
  });

  it("M3: one network failing does not block the others; the tick reports failure", async () => {
    reader.setPosition(8453, SAFE, position(8453));
    reader.setPosition(84532, SAFE, position(84532));
    await expect(runMonitorTick({ db, lenders, reader: failing(reader, 84532), now: t0, log: quiet })).rejects.toThrow(/84532/);
    const snaps = await db.select().from(snapshots);
    expect(snaps.map((s) => s.chainId)).toEqual([8453]);
    const status = await db.select().from(monitorStatus);
    expect(status.find((s) => s.chainId === 8453)).toMatchObject({ lastError: null, loanCount: 1 });
    expect(status.find((s) => s.chainId === 84532)).toMatchObject({ lastError: "rpc down", lastOkAt: null });
  });

  it("survives a paused or frozen market (reads of the position still work)", async () => {
    const [m] = [...reader.state.markets.values()];
    reader.setMarket(8453, { ...m, isPaused: true, isFrozen: true });
    reader.setPosition(8453, SAFE, position(8453));
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet });
    expect(await db.select().from(snapshots)).toHaveLength(1);
  });

  it("G3: writes one Activity row when watching stops and one when it resumes, not one per tick", async () => {
    reader.setPosition(8453, SAFE, position(8453));
    const bad = failing(reader, 8453);
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet }).catch(() => {});
    await runMonitorTick({ db, lenders, reader: bad, now: at(60_000), log: quiet }).catch(() => {});
    await runMonitorTick({ db, lenders, reader: bad, now: at(120_000), log: quiet }).catch(() => {});
    let rows = await db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(rows.map((r) => [r.actor, r.kind, r.chainId])).toEqual([["Agent", "status", 8453]]);
    expect(rows[0].text).toMatch(/not watching/i);
    await runMonitorTick({ db, lenders, reader, now: at(180_000), log: quiet });
    rows = await db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(rows).toHaveLength(2);
    expect(rows[1].text).toMatch(/watching/i);
  });
});

describe("monitorStatusFor (BP-18 header and dashboard)", () => {
  const status = (now: Date, chainIds: ChainId[] = [8453, 84532]) => monitorStatusFor(db, safeId, chainIds, now);

  it("not_watched when no tracked network has the agent", async () => {
    await db.update(safeNetworks).set({ agentAdded: false });
    expect((await status(t0)).state).toBe("not_watched");
  });

  it("starting before the first tick, then watching with the loan count, last check time and source", async () => {
    expect((await status(t0)).state).toBe("starting");
    reader.setPosition(8453, SAFE, position(8453));
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet });
    expect(await status(at(30_000))).toMatchObject({ state: "watching", loans: 1, lastCheckAt: t0, source: "Aave v3 on Base · Aave v3 on Base Sepolia" });
  });

  it("failing once any watched network failed its last tick: the header must not claim to watch", async () => {
    reader.setPosition(8453, SAFE, position(8453));
    await runMonitorTick({ db, lenders, reader: failing(reader, 84532), now: t0, log: quiet }).catch(() => {});
    expect((await status(at(1000))).state).toBe("failing");
    await runMonitorTick({ db, lenders, reader, now: at(60_000), log: quiet });
    expect((await status(at(61_000))).state).toBe("watching");
  });

  it("failing when the last check is older than the stall limit (the worker stopped)", async () => {
    reader.setPosition(8453, SAFE, position(8453));
    await runMonitorTick({ db, lenders, reader, now: t0, log: quiet });
    expect((await status(at(60 * 60_000), [8453])).state).toBe("failing");
  });

  it("only looks at networks the caller may see (G4)", async () => {
    reader.setPosition(8453, SAFE, position(8453));
    await runMonitorTick({ db, lenders, reader: failing(reader, 84532), now: t0, log: quiet }).catch(() => {});
    expect((await status(at(1000), [8453])).state).toBe("watching");
  });
});
