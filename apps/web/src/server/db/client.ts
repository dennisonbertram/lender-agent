// Database access. Postgres (postgres-js) when DATABASE_URL is set, otherwise PGlite in process
// (tests, and `MOCK=1` dev; PGLITE_DIR keeps data between restarts). Owner: the coordinator.
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzlePglite<typeof schema>>;

export const MIGRATIONS_DIR = path.join(process.cwd().endsWith(path.join("apps", "web")) ? process.cwd() : path.join(process.cwd(), "apps", "web"), "drizzle");

/** A fresh in-memory database with every migration applied. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

async function createPostgresDb(url: string): Promise<Db> {
  const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
    import("postgres"),
    import("drizzle-orm/postgres-js"),
    import("drizzle-orm/postgres-js/migrator"),
  ]);
  // Migrate over the direct (unpooled) URL with a short-lived client; pgbouncer in transaction mode is a poor fit for DDL.
  const migrationClient = postgres(process.env.DATABASE_URL_UNPOOLED || url, { max: 1, prepare: false });
  try {
    // Concurrent cold starts would race the same DDL: one session-level advisory lock serializes them.
    await migrationClient`select pg_advisory_lock(7317001)`;
    await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await migrationClient.end(); // ending the session releases the lock
  }
  // Queries use the pooled URL; prepared statements do not survive pgbouncer transaction mode.
  const db = drizzle(postgres(url, { max: 3, prepare: false }), { schema });
  // Both drivers expose the same query builder; the PGlite type is used as the common type.
  return db as unknown as Db;
}

const globalForDb = globalThis as unknown as { __lenderDb?: Promise<Db> };

/** The process-wide database. Migrations run once on first use. */
export function getDb(): Promise<Db> {
  if (!globalForDb.__lenderDb && !process.env.DATABASE_URL && process.env.NODE_ENV === "production" && process.env.MOCK !== "1") {
    throw new Error("DATABASE_URL is not set. In production the app needs a Postgres database; it will not fall back to in-memory PGlite.");
  }
  globalForDb.__lenderDb ??= (process.env.DATABASE_URL
    ? createPostgresDb(process.env.DATABASE_URL)
    : createPgliteDb(process.env.PGLITE_DIR)
  ).catch((e) => {
    globalForDb.__lenderDb = undefined; // a failed start is retried by the next call, not cached
    throw e;
  });
  return globalForDb.__lenderDb;
}

/** Tests only: replace the process-wide database. */
export function setDbForTests(db: Db | undefined) {
  globalForDb.__lenderDb = db ? Promise.resolve(db) : undefined;
}

export { schema };
