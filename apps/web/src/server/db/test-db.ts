// Tests: a fresh PGlite database per call, migrations applied, no server needed.
import { createPgliteDb, type Db } from "./client";

export const createTestDb = (): Promise<Db> => createPgliteDb();
export type { Db };
