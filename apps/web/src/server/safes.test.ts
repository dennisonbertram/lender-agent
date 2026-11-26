import { beforeEach, describe, expect, it, vi } from "vitest";
import * as loansMod from "@/server/loans";
import { createFixtureReader } from "@/server/chain/fixture";
import { createTestDb, type Db } from "@/server/db/test-db";
import { monitorStatus, safeNetworks, safes, workerTicks } from "@/server/db/schema";
import type { SafeContext } from "@/server/request";
import type { Address } from "@/shared/types";
import { safeSummary } from "./safes";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
let db: Db;
let safeId: number;

const ctx = () => ({
  db, services: { reader: createFixtureReader() }, safe: { id: safeId, address: SAFE.toLowerCase(), name: "Main" },
  networks: [{ safeId, chainId: 8453, deployed: true, agentAdded: true }],
  access: { ownedChainIds: [8453], trackedChainIds: [8453], chat: true, ownersDiffer: false },
}) as unknown as SafeContext;

const okTick = () => db.insert(workerTicks).values({ job: "monitor", workerId: "w", startedAt: new Date(), finishedAt: new Date(), ok: true });

beforeEach(async () => {
  db = await createTestDb();
  [{ id: safeId }] = await db.insert(safes).values({ address: SAFE.toLowerCase(), name: "Main" }).returning();
  await db.insert(safeNetworks).values({ safeId, chainId: 8453, deployed: true, agentAdded: true });
});

describe("safeSummary monitorStarting", () => {
  it("is true with a live worker and no first check for this Safe yet", async () => {
    await okTick();
    const s = await safeSummary(ctx());
    expect(s).toMatchObject({ monitorStarting: true, watching: false, monitorFailing: false });
  });

  it("is false once this Safe has a check row (it is watching)", async () => {
    await okTick();
    await db.insert(monitorStatus).values({ safeId, chainId: 8453, lastCheckAt: new Date(), source: "chain", loanCount: 0 });
    const s = await safeSummary(ctx());
    expect(s).toMatchObject({ monitorStarting: false, watching: true, monitorFailing: false });
  });

  it("is false, and the checks count as failing, with no worker tick at all", async () => {
    const s = await safeSummary(ctx());
    expect(s).toMatchObject({ monitorStarting: false, watching: false, monitorFailing: true });
  });
});

describe("safeSummary monitorFirstCheckDue", () => {
  it("is true with a live worker and no check yet", async () => {
    await okTick();
    expect((await safeSummary(ctx())).monitorFirstCheckDue).toBe(true);
  });
  it("is false with no worker tick, or once a check exists", async () => {
    expect((await safeSummary(ctx())).monitorFirstCheckDue).toBe(false);
    await okTick();
    await db.insert(monitorStatus).values({ safeId, chainId: 8453, lastCheckAt: new Date(), source: "chain", loanCount: 0 });
    expect((await safeSummary(ctx())).monitorFirstCheckDue).toBe(false);
  });
});

describe("safeSummary monitorLastCheckAt", () => {
  it("is the last check time as ISO text, or null before any check", async () => {
    await okTick();
    expect((await safeSummary(ctx())).monitorLastCheckAt).toBeNull();
    const at = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(monitorStatus).values({ safeId, chainId: 8453, lastCheckAt: at, source: "chain", loanCount: 0 });
    expect((await safeSummary(ctx())).monitorLastCheckAt).toBe(at.toISOString());
  });
});

describe("safeSummary loan read failure", () => {
  it("returns loans: null with loansError instead of an empty list", async () => {
    await okTick();
    const spy = vi.spyOn(loansMod, "loansFor").mockRejectedValueOnce(new Error("rpc down"));
    const s = await safeSummary(ctx());
    expect(s.loans).toBeNull();
    expect(s.loansError).toBe(true);
    spy.mockRestore();
  });
  it("has loansError false when the read works", async () => {
    await okTick();
    const s = await safeSummary(ctx());
    expect(Array.isArray(s.loans)).toBe(true);
    expect(s.loansError).toBe(false);
  });
});
