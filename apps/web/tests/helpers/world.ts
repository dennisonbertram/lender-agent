// Integration tests: the mock world (fixture chain, fake Safe service, dev signer) on a fresh
// PGlite database by default, installed as the process services. Call `world.reset()` in afterEach.
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import { setDbForTests } from "@/server/db/client";
import { safeNetworks, safes, userSafes } from "@/server/db/schema";
import { createTestDb, type Db } from "@/server/db/test-db";
import { createMockServices, setServicesForTests, type Services } from "@/server/services";
import type { Address, ChainId, SafeSetup } from "@/shared/types";

export type TestWorld = {
  db: Db;
  services: Services & Required<Pick<Services, "fixture" | "fakes">>;
  /** A cookie header for a signed-in wallet. */
  signIn(address: Address): Promise<{ cookie: string; userId: number }>;
  /** Track a Safe in the app (a `safes` row plus one `safe_networks` row per chain). */
  trackSafe(address: Address, opts?: { name?: string; chainIds?: ChainId[]; agentAdded?: boolean; userId?: number; setup?: SafeSetup }): Promise<number>;
  /** Build a Request for a route handler, signed in with `cookie`. */
  req(url: string, init?: RequestInit & { cookie?: string; json?: unknown }): Request;
  reset(): void;
};

export async function createTestWorld(database?: Db): Promise<TestWorld> {
  const db = database ?? await createTestDb();
  const services = createMockServices({ db: async () => db }) as TestWorld["services"];
  setServicesForTests(services);
  setDbForTests(db);
  return {
    db,
    services,
    async signIn(address) {
      const { token, userId } = await createSession(db, { address, chainId: 8453 });
      return { cookie: `${SESSION_COOKIE}=${token}`, userId };
    },
    async trackSafe(address, opts = {}) {
      const [row] = await db.insert(safes).values({ address: address.toLowerCase(), name: opts.name ?? "Main Safe", ...(opts.setup ? { setup: opts.setup } : {}) }).returning();
      for (const chainId of opts.chainIds ?? [8453]) {
        await db.insert(safeNetworks).values({ safeId: row.id, chainId, deployed: true, agentAdded: opts.agentAdded ?? false });
      }
      if (opts.userId) await db.insert(userSafes).values({ userId: opts.userId, safeId: row.id });
      return row.id;
    },
    req(url, init = {}) {
      const headers = new Headers(init.headers);
      if (init.cookie) headers.set("cookie", init.cookie);
      if (init.json !== undefined) headers.set("content-type", "application/json");
      headers.set("host", "localhost:3000");
      return new Request(new URL(url, "http://localhost:3000"), { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    },
    reset() {
      setServicesForTests(undefined);
      setDbForTests(undefined);
    },
  };
}
