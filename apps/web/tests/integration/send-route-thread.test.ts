// BP-14 + BP-08: Send to Safe puts the proposal card in the Safe's chat thread once.
import { planDrafts, safes } from "@/server/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { messages } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import type { Hex } from "@/shared/types";
import { POST } from "@/app/api/safes/[address]/proposals/route";
import { createTestWorld, type TestWorld } from "../helpers/world";

const params = { params: Promise.resolve({ address: MOCK_SAFE }) };
let w: TestWorld;

beforeEach(async () => {
  w = await createTestWorld();
  await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await w.services.fakes.get(8453)!.addDelegate({ safe: getAddress(MOCK_SAFE), delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
});
afterEach(() => w.reset());

const setLive = async (draftKey: string) => {
  const [{ id }] = await w.db.select({ id: safes.id }).from(safes).limit(1);
  const draft = { text: "$2,000", hfIdx: 1, months: 12, cash: 2000, msgId: "m1", draftKey, seen: ["m1"] };
  await w.db.insert(planDrafts).values({ safeId: id, draft }).onConflictDoUpdate({ target: planDrafts.safeId, set: { draft } });
};

describe("Send to Safe and the chat thread", () => {
  it("appends one data-proposal message, also when pressed twice", async () => {
    const { cookie } = await w.signIn(MOCK_OWNER);
    const body = { draftKey: "draft-1", cash: 1000, asset: "ETH", network: "base", venueId: "aave-v3", hfIdx: 1, months: 12 };
    await setLive("draft-1");
    const first = await (await POST(w.req(`/api/safes/${MOCK_SAFE}/proposals`, { method: "POST", cookie, json: body }), params)).json();
    const second = await (await POST(w.req(`/api/safes/${MOCK_SAFE}/proposals`, { method: "POST", cookie, json: body }), params)).json();
    expect(first.stage).toBe("queued");
    expect(second.proposalId).toBe(first.proposalId);
    const rows = await w.db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect((rows[0].message as { parts: unknown[] }).parts).toEqual([{ type: "data-proposal", data: { proposalId: first.proposalId } }]);
  });
});
