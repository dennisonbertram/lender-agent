import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-db";
import { safes, users } from "./schema";

describe("database schema", () => {
  it("applies the migrations to an empty PGlite database", async () => {
    const db = await createTestDb();
    await db.insert(users).values({ address: "0x00000000000000000000000000000000000000aa" });
    const [safe] = await db.insert(safes).values({ address: "0x00000000000000000000000000000000000000bb", name: "Family" }).returning();
    expect(safe.id).toBeGreaterThan(0);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
