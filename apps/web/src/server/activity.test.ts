import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { safes } from "@/server/db/schema";
import { listActivity, recordActivity } from "./activity";
import * as mod from "./activity";

describe("recordActivity", () => {
  it("appends rows and dedupes by event key", async () => {
    const db = await createTestDb();
    const [safe] = await db.insert(safes).values({ address: "0x00000000000000000000000000000000000000bb", name: "Family" }).returning();
    await recordActivity(db, { safeId: safe.id, chainId: 8453, actor: "Agent", kind: "read", text: "Read balances" });
    const first = await recordActivity(db, { safeId: safe.id, actor: "Co-signer", actorAddress: "0xAbC0000000000000000000000000000000000001", kind: "signed", text: "Signed", eventKey: "sig:1" });
    const again = await recordActivity(db, { safeId: safe.id, actor: "Co-signer", kind: "signed", text: "Signed", eventKey: "sig:1" });
    expect(first?.actorAddress).toBe("0xabc0000000000000000000000000000000000001");
    expect(again).toBeNull();
    const rows = await listActivity(db, safe.id, "oldest");
    expect(rows.map((r) => r.text)).toEqual(["Read balances", "Signed"]);
  });

  it("stores a valid tx hash and safe tx hash lowercased, and ignores a malformed one", async () => {
    const db = await createTestDb();
    const [safe] = await db.insert(safes).values({ address: "0x00000000000000000000000000000000000000cc", name: "Family" }).returning();
    const good = await recordActivity(db, { safeId: safe.id, actor: "Agent", kind: "status", text: "A", txHash: `0x${"AB".repeat(32)}`, safeTxHash: `0x${"cd".repeat(32)}` });
    const bad = await recordActivity(db, { safeId: safe.id, actor: "Agent", kind: "status", text: "B", txHash: "0x1234", safeTxHash: "nope" });
    const none = await recordActivity(db, { safeId: safe.id, actor: "Agent", kind: "status", text: "C" });
    expect(good).toMatchObject({ txHash: `0x${"ab".repeat(32)}`, safeTxHash: `0x${"cd".repeat(32)}` });
    expect(bad).toMatchObject({ txHash: null, safeTxHash: null });
    expect(none).toMatchObject({ txHash: null, safeTxHash: null });
  });

  it("has no update or delete path", () => {
    expect(Object.keys(mod).sort()).toEqual(["listActivity", "recordActivity"]);
  });
});
