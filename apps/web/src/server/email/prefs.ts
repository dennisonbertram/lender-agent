// Per-owner email settings (BP-21): the address (used for alerts only), on/off, and the unsubscribe token.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { emailPrefs, users } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { emailDeliveryConfigured } from "./provider";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type ReadDb = Pick<Db, "select">;
type SettingsDb = ReadDb & Pick<Db, "insert" | "update">;

export type EmailSettings = { email: string | null; enabled: boolean; deliveryConfigured: boolean };

async function prefsOf(db: SettingsDb, userId: number) {
  const [row] = await db.select().from(emailPrefs).where(eq(emailPrefs.userId, userId));
  if (row) return row;
  const [made] = await db.insert(emailPrefs).values({ userId, enabled: true, unsubscribeToken: randomBytes(24).toString("hex") })
    .onConflictDoNothing().returning();
  return made ?? (await db.select().from(emailPrefs).where(eq(emailPrefs.userId, userId)))[0];
}

export async function emailSettings(db: ReadDb, userId: number): Promise<EmailSettings> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [p] = await db.select({ enabled: emailPrefs.enabled }).from(emailPrefs).where(eq(emailPrefs.userId, userId));
  return { email: u?.email ?? null, enabled: p?.enabled ?? true, deliveryConfigured: emailDeliveryConfigured() };
}

/** Save the address (null removes it) and/or the on/off choice. Fields omitted by a caller remain unchanged. */
export async function saveEmailSettings(db: Db, userId: number, input: { email?: string | null; enabled?: boolean }): Promise<EmailSettings> {
  let email: string | null | undefined;
  if (input.email !== undefined) {
    email = input.email?.trim() || null;
    if (email && (!EMAIL.test(email) || email.length > 254)) throw new HttpError(400, "Enter a valid email address.");
  }
  await db.transaction(async (tx) => {
    if (email !== undefined) await tx.update(users).set({ email }).where(eq(users.id, userId));
    const p = await prefsOf(tx, userId);
    if (input.enabled !== undefined) await tx.update(emailPrefs).set({ enabled: input.enabled, updatedAt: new Date() }).where(eq(emailPrefs.userId, p.userId));
  });
  return emailSettings(db, userId);
}

/** The secret for this owner's unsubscribe link. */
export async function unsubscribeTokenOf(db: Db, userId: number): Promise<string> {
  return (await prefsOf(db, userId)).unsubscribeToken;
}

/** The link in every alert email turns email off for its owner. False for an unknown token. */
export async function unsubscribeByToken(db: Db, token: string): Promise<boolean> {
  if (!/^[0-9a-f]{48}$/.test(token)) return false;
  const rows = await db.update(emailPrefs).set({ enabled: false, updatedAt: new Date() }).where(eq(emailPrefs.unsubscribeToken, token)).returning();
  return rows.length > 0;
}
