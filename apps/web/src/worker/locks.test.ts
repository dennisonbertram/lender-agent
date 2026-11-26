import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { acquireLock, releaseLock } from "./locks";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("locks", () => {
  it("only one of two workers takes a free lock", async () => {
    const db = await createTestDb();
    const [a, b] = await Promise.all([
      acquireLock(db, { job: "j", workerId: "A", now: t0 }),
      acquireLock(db, { job: "j", workerId: "B", now: t0 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("an expired lock can be taken over (crashed worker)", async () => {
    const db = await createTestDb();
    expect(await acquireLock(db, { job: "j", workerId: "A", now: t0, ttlMs: 1000 })).toBe(true);
    expect(await acquireLock(db, { job: "j", workerId: "B", now: at(500) })).toBe(false);
    expect(await acquireLock(db, { job: "j", workerId: "B", now: at(1000) })).toBe(true);
  });

  it("is not due again until the interval has passed since the last run", async () => {
    const db = await createTestDb();
    await acquireLock(db, { job: "j", workerId: "A", now: t0, intervalMs: 60_000 });
    await releaseLock(db, { job: "j", workerId: "A", now: at(10), lastRunAt: t0 });
    expect(await acquireLock(db, { job: "j", workerId: "B", now: at(30_000), intervalMs: 60_000 })).toBe(false);
    expect(await acquireLock(db, { job: "j", workerId: "B", now: at(60_000), intervalMs: 60_000 })).toBe(true);
  });

  it("release by a non-holder does nothing", async () => {
    const db = await createTestDb();
    await acquireLock(db, { job: "j", workerId: "A", now: t0 });
    await releaseLock(db, { job: "j", workerId: "B", now: at(1), lastRunAt: t0 });
    expect(await acquireLock(db, { job: "j", workerId: "B", now: at(2) })).toBe(false);
  });

  // No Postgres server is available here, so this uses a fake `execute` that returns the shape
  // drizzle's postgres-js adapter does (a bare row array, not `{ rows }`); see drizzle-orm/postgres-js/session.js.
  it("handles the postgres-js result shape (array of rows)", async () => {
    const fakeDb = (rows: unknown) => ({ execute: async () => rows }) as unknown as Parameters<typeof acquireLock>[0];
    expect(await acquireLock(fakeDb(Object.assign([{ job: "j", locked_by: "A" }], { count: 1 })), { job: "j", workerId: "A", now: t0 })).toBe(true);
    expect(await acquireLock(fakeDb(Object.assign([], { count: 0 })), { job: "j", workerId: "A", now: t0 })).toBe(false);
    expect(await acquireLock(fakeDb({ rows: [{ job: "j", locked_by: "B" }] }), { job: "j", workerId: "A", now: t0 })).toBe(false);
  });
});
