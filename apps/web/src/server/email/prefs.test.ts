import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { emailPrefs, users } from "@/server/db/schema";
import { createTestDb, type Db } from "@/server/db/test-db";
import { emailSettings, saveEmailSettings } from "./prefs";

let db: Db;
let userId: number;

beforeEach(async () => {
  db = await createTestDb();
  [{ id: userId }] = await db.insert(users).values({ address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", email: "old@example.com" }).returning();
});

describe("saveEmailSettings", () => {
  it("commits the address and enabled flag together", async () => {
    const saved = await saveEmailSettings(db, userId, { email: " next@example.com ", enabled: false });
    expect(saved).toMatchObject({ email: "next@example.com", enabled: false });
  });

  it("preserves email-only and enabled-only updates for existing callers", async () => {
    await saveEmailSettings(db, userId, { enabled: false });
    expect(await saveEmailSettings(db, userId, { email: "next@example.com" })).toMatchObject({ email: "next@example.com", enabled: false });
    expect(await saveEmailSettings(db, userId, { enabled: true })).toMatchObject({ email: "next@example.com", enabled: true });
  });

  it("rejects an invalid email before changing either setting", async () => {
    await expect(saveEmailSettings(db, userId, { email: "not-an-email", enabled: false })).rejects.toThrow(/valid email/i);
    expect(await emailSettings(db, userId)).toMatchObject({ email: "old@example.com", enabled: true });
  });

  it("rolls back the address update if saving the email preference fails", async () => {
    await saveEmailSettings(db, userId, { enabled: true }); // ensure the preference row already exists
    await db.execute(sql`ALTER TABLE email_prefs ADD CONSTRAINT email_prefs_test_must_stay_enabled CHECK (enabled)`);
    await expect(saveEmailSettings(db, userId, { email: "new@example.com", enabled: false })).rejects.toThrow();
    expect(await emailSettings(db, userId)).toMatchObject({ email: "old@example.com", enabled: true });
    const [prefs] = await db.select().from(emailPrefs).where(eq(emailPrefs.userId, userId));
    expect(prefs.enabled).toBe(true);
  });
});
