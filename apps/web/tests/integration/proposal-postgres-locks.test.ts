import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposals, safeNetworks, safes } from "@/server/db/schema";
import { MOCK_SAFE } from "@/server/mock/seed";
import { withNextProposalNonce } from "@/server/proposals/send";
import { createPostgresLockWorld, waitForPostgresLockWait, type PostgresLockWorld } from "../helpers/postgres-lock-db";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const CHAIN_ID = 8453;
const INSERT_PAUSE_LOCK = 7818461;

describe.skipIf(!process.env.PG_LOCK_TEST_URL)("Safe proposal nonce allocation in PostgreSQL", () => {
  let world: PostgresLockWorld;

  beforeAll(async () => { world = await createPostgresLockWorld(); });
  afterAll(async () => { await world?.close(); });

  it("allocates different nonces to concurrent non-loan reservations across sessions", async () => {
    const { dbA, dbB, observer, appA, appB } = world;
    const [safe] = await dbA.insert(safes).values({ address: SAFE.toLowerCase(), name: "Nonce test Safe" }).returning();
    await dbA.insert(safeNetworks).values({ safeId: safe.id, chainId: CHAIN_ID, deployed: true, agentAdded: true });
    const reserve = (db: PostgresLockWorld["dbA"], key: "first" | "second") => withNextProposalNonce(db, safe.id, CHAIN_ID, 0n, async (storage, nonce) => {
      const [row] = await storage.insert(proposals).values({
        id: randomUUID(), safeId: safe.id, chainId: CHAIN_ID, spec: { kind: "close", loanId: `test:${key}` },
        tx: { to: SAFE, value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: nonce.toString() },
        nonce, safeTxHash: `0x${(key === "first" ? "11" : "22").repeat(32)}`,
        idempotencyKey: `postgres-lock:${key}`, title: `Test ${key}`, steps: [], outcome: "Test transaction.", stage: "sending",
        testRun: { ok: true }, createdBy: "postgres-lock-test",
      }).returning();
      return row;
    });

    // Pause the first sender at INSERT, after it has chosen a nonce but before the row exists.
    await observer.unsafe(`
      CREATE FUNCTION pause_proposal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${INSERT_PAUSE_LOCK});
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER pause_proposal_insert BEFORE INSERT ON proposals
        FOR EACH ROW EXECUTE FUNCTION pause_proposal_insert();
    `);
    await observer`select pg_advisory_lock(${INSERT_PAUSE_LOCK})`;

    let first: ReturnType<typeof reserve> | undefined;
    let second: ReturnType<typeof reserve> | undefined;
    let waitedForAllocation = false;
    try {
      first = reserve(dbA, "first");
      void first.catch(() => {});
      expect(await waitForPostgresLockWait(observer, appA, 'insert into "proposals"')).toBe(true);
      second = reserve(dbB, "second");
      void second.catch(() => {});
      expect(await waitForPostgresLockWait(observer, appB, "")).toBe(true);
      const [waiting] = await observer`select query from pg_stat_activity where application_name = ${appB}`;
      waitedForAllocation = waiting.query.includes("pg_advisory_xact_lock");
    } finally {
      await observer`select pg_advisory_unlock(${INSERT_PAUSE_LOCK})`;
      await Promise.allSettled([first, second]);
    }

    expect(await first).toMatchObject({ stage: "sending" });
    expect(await second).toMatchObject({ stage: "sending" });
    const rows = await dbA.select().from(proposals).where(eq(proposals.safeId, safe.id));
    expect(rows.map((row) => row.nonce).sort()).toEqual([0n, 1n]);
    expect(waitedForAllocation).toBe(true);
  });
});
