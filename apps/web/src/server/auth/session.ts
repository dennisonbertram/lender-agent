// Sessions: a random token in an http-only cookie; only its sha256 is stored.
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, users } from "@/server/db/schema";
import type { Db } from "@/server/db/client";
import type { Address } from "@/shared/types";

export const SESSION_COOKIE = "la_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Session = { userId: number; address: Address; chainId: number; expiresAt: Date };

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(
  db: Db,
  p: { address: Address; chainId: number; now?: Date },
): Promise<{ token: string; expiresAt: Date; userId: number }> {
  const now = p.now ?? new Date();
  const address = p.address.toLowerCase();
  const [user] = await db
    .insert(users)
    .values({ address })
    .onConflictDoUpdate({ target: users.address, set: { address } })
    .returning({ id: users.id });
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: hashToken(token), userId: user.id, address, chainId: p.chainId, createdAt: now, expiresAt });
  return { token, expiresAt, userId: user.id };
}

export async function getSession(db: Db, cookieValue: string | undefined | null, now: Date = new Date()): Promise<Session | null> {
  if (!cookieValue) return null;
  const [row] = await db.select().from(sessions).where(eq(sessions.id, hashToken(cookieValue))).limit(1);
  if (!row || row.expiresAt <= now) return null;
  return { userId: row.userId, address: row.address as Address, chainId: row.chainId, expiresAt: row.expiresAt };
}

export async function destroySession(db: Db, cookieValue: string | undefined | null): Promise<void> {
  if (!cookieValue) return;
  await db.delete(sessions).where(eq(sessions.id, hashToken(cookieValue)));
}

/** The `Set-Cookie` header value. `expiresAt: null` clears the cookie. */
export function sessionCookie(token: string, expiresAt: Date | null, secure = process.env.NODE_ENV === "production"): string {
  const parts = [
    `${SESSION_COOKIE}=${expiresAt ? token : ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    expiresAt ? `Expires=${expiresAt.toUTCString()}` : "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}
