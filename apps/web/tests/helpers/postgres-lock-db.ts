import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "@/server/db/schema";
import { MIGRATIONS_DIR, type Db } from "@/server/db/client";

type SqlClient = ReturnType<typeof postgres>;

export type PostgresLockWorld = {
  dbA: Db;
  dbB: Db;
  appA: string;
  appB: string;
  /** Independent observer connection for checking PostgreSQL's lock wait state. */
  observer: SqlClient;
  close(): Promise<void>;
};

/**
 * Create a disposable database and two one-connection PostgreSQL pools. PGlite
 * cannot prove cross-session row/advisory lock behavior, so this helper refuses
 * to silently fall back to it.
 */
export async function createPostgresLockWorld(): Promise<PostgresLockWorld> {
  const baseUrl = process.env.PG_LOCK_TEST_URL;
  if (!baseUrl) throw new Error("Set PG_LOCK_TEST_URL to a local PostgreSQL admin URL.");

  const dbName = `reserve_lock_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, prepare: false, connection: { application_name: "reserve-lock-admin" } });
  const quotedName = `"${dbName}"`;
  let appA: string | undefined;
  let appB: string | undefined;
  let observer: SqlClient | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${quotedName}`);
    const dbUrl = new URL(baseUrl);
    dbUrl.pathname = `/${dbName}`;
    appA = `reserve-lock-a-${dbName.slice(-8)}`;
    appB = `reserve-lock-b-${dbName.slice(-8)}`;
    const clientA = postgres(dbUrl.toString(), { max: 1, prepare: false, connection: { application_name: appA } });
    const clientB = postgres(dbUrl.toString(), { max: 1, prepare: false, connection: { application_name: appB } });
    observer = postgres(dbUrl.toString(), { max: 1, prepare: false, connection: { application_name: "reserve-lock-observer" } });
    const migrateDb = drizzle(clientA, { schema });
    await migrate(migrateDb, { migrationsFolder: MIGRATIONS_DIR });
    const dbA = migrateDb as unknown as Db;
    const dbB = drizzle(clientB, { schema }) as unknown as Db;

    return {
      dbA, dbB, appA, appB, observer,
      async close() {
        await Promise.all([clientA.end({ timeout: 1 }), clientB.end({ timeout: 1 }), observer!.end({ timeout: 1 })]);
        await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedName}`);
        await admin.end({ timeout: 1 });
      },
    };
  } catch (error) {
    if (observer) await observer.end({ timeout: 1 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedName}`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
    throw error;
  }
}

/** Wait until PostgreSQL reports the independent session blocked on the expected lock query. */
export async function waitForPostgresLockWait(observer: SqlClient, appName: string, queryPart: string): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer.unsafe(
      `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query ILIKE $2`,
      [appName, `%${queryPart}%`],
    );
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
