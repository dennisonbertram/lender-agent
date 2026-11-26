import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/server/db/test-db";
import { sessions, users } from "@/server/db/schema";
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, destroySession, getSession, hashToken, sessionCookie } from "./session";

const address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;

describe("sessions", () => {
  it("stores only the sha256 of the token, expires in 7 days, upserts the user", async () => {
    const db = await createTestDb();
    const now = new Date("2026-01-01T00:00:00Z");
    const a = await createSession(db, { address, chainId: 8453, now });
    const b = await createSession(db, { address, chainId: 8453, now });
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.userId).toBe(b.userId);
    expect(await db.select().from(users)).toHaveLength(1);
    const rows = await db.select().from(sessions).where(eq(sessions.id, hashToken(a.token)));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(a.token);
    expect(rows[0].expiresAt.getTime() - now.getTime()).toBe(SESSION_TTL_MS);
    expect((await db.select().from(sessions)).some((r) => r.id === a.token)).toBe(false);
  });

  it("getSession returns the session until expiry, destroySession ends it", async () => {
    const db = await createTestDb();
    const now = new Date("2026-01-01T00:00:00Z");
    const { token } = await createSession(db, { address, chainId: 8453, now });
    expect((await getSession(db, token, now))?.address).toBe(address);
    expect(await getSession(db, token, new Date(now.getTime() + SESSION_TTL_MS + 1))).toBeNull();
    expect(await getSession(db, "nope", now)).toBeNull();
    await destroySession(db, token);
    expect(await getSession(db, token, now)).toBeNull();
  });

  it("cookie is http-only and SameSite=Lax, Secure in production", () => {
    const exp = new Date("2026-01-08T00:00:00Z");
    const c = sessionCookie("abc", exp, false);
    expect(c).toContain(`${SESSION_COOKIE}=abc`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Secure");
    expect(sessionCookie("abc", exp, true)).toContain("Secure");
    expect(sessionCookie("", null, false)).toContain("Max-Age=0");
  });
});
