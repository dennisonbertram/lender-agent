import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposals } from "@/server/db/schema";
import { saveEmailSettings } from "@/server/email/prefs";
import { DevEmailProvider } from "@/server/email/provider";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE } from "@/server/mock/seed";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { notifyCosigners, notifyQueuedProposals } from "./notify-cosigners";

let w: TestWorld;
let safeId: number;
let ownerId: number;
let coId: number;
let mail: DevEmailProvider;
const deps = () => ({ db: w.db, reader: w.services.reader, email: mail as DevEmailProvider | null, log: () => {} });

async function proposal(over: Partial<typeof proposals.$inferInsert> = {}) {
  const id = over.id ?? "p1";
  await w.db.insert(proposals).values({ id, safeId, chainId: 8453, spec: { kind: "loan" }, idempotencyKey: `k-${id}`, title: "Borrow $1,000 against 0.62 ETH on Morpho", steps: [], outcome: "", stage: "queued", threshold: 2, createdBy: MOCK_OWNER.toLowerCase(), ...over });
  return id;
}

beforeEach(async () => {
  w = await createTestWorld();
  mail = new DevEmailProvider();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  ownerId = (await w.signIn(MOCK_OWNER)).userId;
  coId = (await w.signIn(MOCK_COSIGNER)).userId;
});
afterEach(() => w.reset());

describe("notifyCosigners", () => {
  it("emails the co-owner with an address, not the sender", async () => {
    await saveEmailSettings(w.db, ownerId, { email: "owner@example.com" });
    await saveEmailSettings(w.db, coId, { email: "co@example.com" });
    await notifyCosigners(deps(), await proposal());
    expect(mail.sent.map((m) => m.to)).toEqual(["co@example.com"]);
    expect(mail.sent[0].subject).toMatch(/^Approval needed on your Safe 0x[0-9a-f]{4}…[0-9a-f]{4}$/i);
    expect(mail.sent[0].subject).not.toContain("Morpho");
    expect(mail.sent[0].text).toContain("Borrow $1,000 against 0.62 ETH on Morpho");
    expect(mail.sent[0].text).toContain("/proposals/p1");
  });

  it("skips an owner with no email or with alerts off", async () => {
    await notifyCosigners(deps(), await proposal());
    expect(mail.sent).toEqual([]);
    await saveEmailSettings(w.db, coId, { email: "co@example.com", enabled: false });
    await notifyCosigners(deps(), "p1");
    expect(mail.sent).toEqual([]);
  });

  it("skips an owner who already signed, and a proposal that is not queued", async () => {
    await saveEmailSettings(w.db, coId, { email: "co@example.com" });
    await proposal({ confirmations: [{ owner: MOCK_COSIGNER.toLowerCase(), submittedAt: "2026-01-01T00:00:00Z" }] });
    await notifyCosigners(deps(), "p1");
    await proposal({ id: "p2", stage: "sending" });
    await notifyCosigners(deps(), "p2");
    expect(mail.sent).toEqual([]);
  });

  it("skips an owner who signed in the Safe service but not yet in the stored confirmations", async () => {
    await saveEmailSettings(w.db, coId, { email: "co@example.com" });
    await proposal({ safeTxHash: "0x" + "ab".repeat(32) });
    const safeService = () => ({ getMultisigTransaction: async () => ({ confirmations: [{ owner: MOCK_COSIGNER, submissionDate: "2026-01-01T00:00:00Z" }] }) }) as never;
    await notifyCosigners({ ...deps(), safeService }, "p1");
    expect(mail.sent).toEqual([]);
  });

  it("falls back to stored confirmations when the Safe service fails", async () => {
    await saveEmailSettings(w.db, coId, { email: "co@example.com" });
    await proposal({ safeTxHash: "0x" + "ab".repeat(32) });
    const safeService = () => ({ getMultisigTransaction: async () => { throw new Error("down"); } }) as never;
    await notifyCosigners({ ...deps(), safeService }, "p1");
    expect(mail.sent).toHaveLength(1);
  });

  it("sends once per proposal, even from a fresh provider", async () => {
    await saveEmailSettings(w.db, coId, { email: "co@example.com" });
    await proposal();
    await notifyCosigners(deps(), "p1");
    await notifyCosigners(deps(), "p1");
    mail = new DevEmailProvider();
    await notifyQueuedProposals(deps());
    expect(mail.sent).toEqual([]);
  });

  it("does nothing when email is not configured, and sends later when it is", async () => {
    await saveEmailSettings(w.db, coId, { email: "co@example.com" });
    await proposal();
    await notifyCosigners({ ...deps(), email: null }, "p1");
    await notifyQueuedProposals(deps());
    expect(mail.sent).toHaveLength(1);
  });

  it("never throws when the transport fails", async () => {
    await saveEmailSettings(w.db, coId, { email: "co@example.com" });
    await proposal();
    mail.failNext = 1;
    await expect(notifyCosigners(deps(), "p1")).resolves.toBeUndefined();
    await notifyCosigners(deps(), "p1");
    expect(mail.sent).toHaveLength(1);
  });
});
