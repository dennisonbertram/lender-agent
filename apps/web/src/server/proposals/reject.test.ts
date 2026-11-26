import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activity, proposals } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { delegateTypedData, deleteRequestTypedData } from "@/server/safe/hash";
import { SafeServiceError } from "@/server/safe/service-client";
import { safeContext } from "@/server/request";
import type { Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { rejectProposal } from "./reject";
import { sendLive as sendToSafe } from "@/../tests/helpers/live-send";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;
const fake = () => w.services.fakes.get(8453)!;

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => { vi.restoreAllMocks(); w.reset(); });

const queue = async (key = "d1") => {
  const r = await sendToSafe(ctx, { draftKey: key, chainId: 8453, cash: 2000, hfIdx: 1 });
  const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
  return row;
};
const asDraft = async (id: string) => w.db.update(proposals).set({ stage: "draft", safeTxHash: null }).where(eq(proposals.id, id));
const acts = () => w.db.select().from(activity).where(eq(activity.safeId, safeId));

describe("rejectProposal", () => {
  it("a draft is rejected: nothing was sent", async () => {
    const row = await queue();
    await asDraft(row.id);
    const spy = vi.spyOn(fake(), "deleteTransaction");
    const v = await rejectProposal(ctx, row.id);
    expect(v.stage).toBe("rejected");
    expect(v.sentence).toBe("Rejected. Nothing was sent.");
    expect(spy).not.toHaveBeenCalled();
    expect((await acts()).some((a) => a.actor === "You" && /rejected/.test(a.text))).toBe(true);
  });

  it("an unconfirmed queued proposal is deleted from the queue with the agent's signed DeleteRequest", async () => {
    const row = await queue();
    const spy = vi.spyOn(fake(), "deleteTransaction");
    const v = await rejectProposal(ctx, row.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await fake().getMultisigTransaction(row.safeTxHash as Hex)).toBeNull();
    expect(v).toMatchObject({ stage: "rejected", sentence: "Rejected. Nothing was sent.", inSafe: false });
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, row.id));
    expect(after.deletedFromQueue).toBe(true);
    const list = await acts();
    expect(list.some((a) => a.actor === "You")).toBe(true);
    expect(list.some((a) => a.actor === "Agent" && /deleted/.test(a.text))).toBe(true);
  });

  it("an owner-confirmed proposal is not deleted: the server checks confirmations first", async () => {
    const row = await queue();
    fake().confirm(row.safeTxHash as Hex, MOCK_COSIGNER);
    const spy = vi.spyOn(fake(), "deleteTransaction");
    const v = await rejectProposal(ctx, row.id);
    expect(spy).not.toHaveBeenCalled();
    expect(await fake().getMultisigTransaction(row.safeTxHash as Hex)).not.toBeNull();
    expect(v.sentence).toBe("Rejected here. It is still in your Safe queue. Reject it in Safe too.");
    expect(v.inSafe).toBe(true);
    expect(v.sentence).not.toMatch(/cancel/i);
  });

  it("a refused delete leaves it in the queue, same sentence", async () => {
    const row = await queue();
    vi.spyOn(fake(), "deleteTransaction").mockRejectedValue(new SafeServiceError(422, { detail: "no" }));
    const v = await rejectProposal(ctx, row.id);
    expect(v.stage).toBe("rejected");
    expect(v.sentence).toBe("Rejected here. It is still in your Safe queue. Reject it in Safe too.");
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, row.id));
    expect(after.deletedFromQueue).toBe(false);
  });

  it("an executed proposal cannot be rejected (409)", async () => {
    const row = await queue();
    await w.db.update(proposals).set({ stage: "executed" }).where(eq(proposals.id, row.id));
    await expect(rejectProposal(ctx, row.id)).rejects.toMatchObject({ status: 409 });
  });

  it("one that already ran in Safe (not yet followed) is not deleted or rejected (409)", async () => {
    const row = await queue();
    fake().markExecuted(row.safeTxHash as Hex, { success: true, txHash: `0x${"11".repeat(32)}` });
    const spy = vi.spyOn(fake(), "deleteTransaction");
    await expect(rejectProposal(ctx, row.id)).rejects.toMatchObject({ status: 409 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a stranger gets 403", async () => {
    await expect(safeContext(w.req("/", { cookie: (await w.signIn(MOCK_STRANGER)).cookie }), MOCK_SAFE, w.services)).rejects.toMatchObject({ status: 403 });
  });
});

describe("delete-request typed data matches the service's format", () => {
  it("domain, types and hash (M0-3: Safe Transaction Service 1.0, verifyingContract = the Safe, totp = hour)", () => {
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const td = deleteRequestTypedData(8453, SAFE, hash, 480_000);
    expect(td.domain).toEqual({ name: "Safe Transaction Service", version: "1.0", chainId: 8453, verifyingContract: SAFE });
    expect(td.types).toEqual({ DeleteRequest: [{ name: "safeTxHash", type: "bytes32" }, { name: "totp", type: "uint256" }] });
    expect(td.message).toEqual({ safeTxHash: hash, totp: 480_000n });
    expect(hashTypedData(td)).toBe(hashTypedData({
      domain: { name: "Safe Transaction Service", version: "1.0", chainId: 8453, verifyingContract: SAFE },
      types: { DeleteRequest: [{ name: "safeTxHash", type: "bytes32" }, { name: "totp", type: "uint256" }] },
      primaryType: "DeleteRequest", message: { safeTxHash: hash, totp: 480_000n },
    }));
  });
});
