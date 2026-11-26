import { beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "@/server/db/schema";
import { createTestDb, type Db } from "@/server/db/test-db";
import { emailSettings, unsubscribeTokenOf } from "@/server/email/prefs";

let db: Db;
vi.mock("@/server/db/client", async (orig) => ({ ...(await orig<object>()), getDb: async () => db }));
const { GET, POST } = await import("./route");

let userId: number;
let token: string;
const url = (t = token) => `http://localhost/api/alerts/unsubscribe?token=${t}`;
const enabled = async () => (await emailSettings(db, userId)).enabled;

beforeEach(async () => {
  db = await createTestDb();
  [{ id: userId }] = await db.insert(users).values({ address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", email: "o@example.com" }).returning();
  token = await unsubscribeTokenOf(db, userId);
});

describe("unsubscribe route (E4 #15)", () => {
  it("GET shows a confirmation with a POST button and changes nothing (link scanners)", async () => {
    const res = await GET(new Request(url()));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/<form method="post"/);
    expect(html).toContain(`token=${token}`);
    expect(await enabled()).toBe(true);
  });

  it("POST turns alert emails off, from the page's button and from the RFC 8058 one-click request", async () => {
    const res = await POST(new Request(url(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    expect(res.status).toBe(200);
    expect(await enabled()).toBe(false);
  });

  it("POST with an unknown token is refused", async () => {
    expect((await POST(new Request(url("nope"), { method: "POST" }))).status).toBe(404);
    expect(await enabled()).toBe(true);
  });
});
