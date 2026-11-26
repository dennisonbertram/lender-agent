import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/server/db/test-db";
import { proposals, safes } from "@/server/db/schema";
import { listActivity, recordActivity } from "@/server/activity";
import { activityFor, recordSignatures } from "@/server/activity-view";
import type { SafeContext } from "@/server/request";
import type { Address } from "@/shared/types";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

let db: Db;
let safeId: number;
beforeEach(async () => {
  db = await createTestDb();
  [{ id: safeId }] = await db.insert(safes).values({ address: "0x1", name: "S" }).returning();
});

const ctx = (wallet: Address, ownedChainIds: number[], chat: boolean) =>
  ({ db, safe: { id: safeId }, wallet, access: { ownedChainIds, chat } }) as unknown as SafeContext;

describe("activityFor", () => {
  it("passes through the proposal, chain, Safe tx hash and tx hash the row holds", async () => {
    const h = `0x${"ab".repeat(32)}`;
    const t = `0x${"cd".repeat(32)}`;
    await recordSignatures(db, { safeId, chainId: 8453, proposalId: "p1", safeTxHash: h, confirmations: [{ owner: A, submittedAt: new Date() }], title: "Repay" });
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "status", text: "Arrived", detail: `Destination transaction on Base (chain 8453): ${t}.` });
    const rows = await activityFor(ctx(A, [8453], true));
    expect(rows.find((r) => r.kind === "signed")).toMatchObject({ chainId: 8453, proposalId: "p1", safeTxHash: h, txHash: null });
    expect(rows.find((r) => r.text === "Arrived")).toMatchObject({ txHash: t, proposalId: null, safeTxHash: null });
  });

  it("tx hash falls back from the column to the proposal to the detail text", async () => {
    const col = `0x${"11".repeat(32)}`, prop = `0x${"22".repeat(32)}`, text = `0x${"33".repeat(32)}`, stx = `0x${"44".repeat(32)}`, stx2 = `0x${"55".repeat(32)}`;
    await db.insert(proposals).values({ id: "pp", safeId, chainId: 8453, title: "T", outcome: "o", idempotencyKey: "ik-pp", stage: "executed", spec: {}, tx: {}, steps: [], executedTxHash: prop, safeTxHash: stx2 } as never);
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "status", text: "col", proposalId: "pp", txHash: col, safeTxHash: stx });
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "status", text: "prop", proposalId: "pp", detail: `see ${text}` });
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "status", text: "text", detail: `see ${text}` });
    const rows = await activityFor(ctx(A, [8453], true));
    const by = (t: string) => rows.find((r) => r.text === t)!;
    expect(by("col")).toMatchObject({ txHash: col, safeTxHash: stx });
    expect(by("prop")).toMatchObject({ txHash: prop, safeTxHash: stx2 });
    expect(by("text")).toMatchObject({ txHash: text, safeTxHash: null });
  });

  it("keeps the chain of a destination hash named in the detail, and drops an unmarked one", async () => {
    const t = `0x${"cd".repeat(32)}`;
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "status", text: "new", detail: `Destination transaction on Arbitrum (chain 42161): ${t}.` });
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "status", text: "old", detail: `Destination transaction ${t}.` });
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "proposed", text: "source only" });
    const rows = await activityFor(ctx(A, [8453], true));
    expect(rows.find((r) => r.text === "new")).toMatchObject({ txHash: t, txChainId: 42161, displayChainId: 42161 });
    expect(rows.find((r) => r.text === "old")).toMatchObject({ txHash: null, txChainId: null, chainId: 8453, displayChainId: null });
    expect(rows.find((r) => r.text === "source only")).toMatchObject({ txHash: null, chainId: 8453, displayChainId: 8453 });
  });

  it("reports the Safe a linked proposal belongs to", async () => {
    const [{ id: reserveId }] = await db.insert(safes).values({ address: "0xabc", name: "Reserve Safe" }).returning();
    await db.insert(proposals).values({ id: "rp", safeId: reserveId, chainId: 8453, title: "T", outcome: "o", idempotencyKey: "ik-rp", stage: "queued", spec: {}, tx: {}, steps: [], safeTxHash: `0x${"66".repeat(32)}` } as never);
    await recordActivity(db, { safeId, chainId: 8453, actor: "You", kind: "proposed", text: "Reserve setup drafted", proposalId: "rp" });
    const [row] = await activityFor(ctx(A, [8453], true));
    expect(row).toMatchObject({ proposalSafe: "0xabc", safeTxHash: `0x${"66".repeat(32)}` });
  });

  it("writes second person only for the actor", async () => {
    await recordActivity(db, { safeId, chainId: 8453, actor: "You", actorAddress: A, kind: "signed", text: "You added the Lender agent to this Safe." });
    expect((await activityFor(ctx(A, [8453], true)))[0].text).toBe("You added the Lender agent to this Safe.");
    const other = (await activityFor(ctx(B, [8453], true)))[0];
    expect(other).toMatchObject({ actor: "Co-signer 0x7099…79C8", text: "Added the Lender agent to this Safe." });
  });

  it("shows You to the signer and Co-signer with a short address to the other owner", async () => {
    await recordSignatures(db, { safeId, chainId: 8453, proposalId: "p1", safeTxHash: "0xabc", confirmations: [{ owner: A, submittedAt: new Date() }], title: "Repay" });
    const mine = await activityFor(ctx(A, [8453], true));
    expect(mine[0]).toMatchObject({ actor: "You", text: "Signed: Repay", kind: "signed" });
    const other = await activityFor(ctx(B, [8453], true));
    expect(other[0].actor).toBe("Co-signer 0x7099…79C8");
  });

  it("keeps agent actors", async () => {
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent (reserve)", kind: "reserve", text: "x" });
    expect((await activityFor(ctx(A, [8453], true)))[0].actor).toBe("Agent (reserve)");
  });

  it("hides rows on networks the viewer does not own, and chain-less rows without chat", async () => {
    await recordActivity(db, { safeId, chainId: 8453, actor: "Agent", kind: "read", text: "base" });
    await recordActivity(db, { safeId, chainId: 84532, actor: "Agent", kind: "read", text: "sepolia" });
    await recordActivity(db, { safeId, actor: "Agent", kind: "read", text: "global" });
    expect((await activityFor(ctx(A, [8453], false))).map((r) => r.text)).toEqual(["base"]);
    expect((await activityFor(ctx(A, [8453], true))).map((r) => r.text).sort()).toEqual(["base", "global"]);
  });
});

describe("recordSignatures", () => {
  it("writes one row per owner, once, however often it is polled", async () => {
    const input = { safeId, chainId: 8453 as const, proposalId: "p1", safeTxHash: "0xABC", confirmations: [{ owner: A, submittedAt: new Date() }, { owner: B, submittedAt: new Date() }], title: "T" };
    expect(await recordSignatures(db, input)).toBe(2);
    expect(await recordSignatures(db, input)).toBe(0);
    expect(await listActivity(db, safeId)).toHaveLength(2);
  });
});
