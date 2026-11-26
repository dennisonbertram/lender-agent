// BP-14: propose a batch as the agent (a Transaction Service delegate) through the real
// SafeServiceClient, served by the fake service's HTTP handler.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activity, proposals } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { MULTISEND_CALL_ONLY } from "@/server/safe/constants";
import { SafeServiceClient } from "@/server/safe/service-client";
import { setServicesForTests, type Services } from "@/server/services";
import type { Hex } from "@/shared/types";
import { POST } from "@/app/api/safes/[address]/proposals/route";
import { createTestWorld, type TestWorld } from "../helpers/world";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const params = { params: Promise.resolve({ address: MOCK_SAFE }) };
let w: TestWorld;
let cookie: string;
let posts = 0;
let loseNextPostResponse = false;
let hideTransaction = false;

beforeEach(async () => {
  w = await createTestWorld();
  await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  cookie = (await w.signIn(MOCK_OWNER)).cookie;
  const fake = w.services.fakes.get(8453)!;
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });

  posts = 0;
  loseNextPostResponse = false;
  hideTransaction = false;
  const client = new SafeServiceClient({
    baseUrl: "http://safe.test",
    fetch: (async (url: string, init?: RequestInit) => {
      const isPost = init?.method === "POST" && String(url).includes("/multisig-transactions/");
      if (isPost) posts++;
      if (hideTransaction && init?.method === "GET" && new URL(url).pathname.startsWith("/api/v1/multisig-transactions/")) {
        return new Response(null, { status: 404 });
      }
      const res = await fake.handler(new Request(url, init));
      if (isPost && res.status === 201 && loseNextPostResponse) {
        loseNextPostResponse = false;
        throw new TypeError("fetch failed"); // accepted, but the response never arrives
      }
      return res;
    }) as typeof fetch,
  });
  const services: Services = { ...w.services, safeService: () => client };
  setServicesForTests(services);
});
afterEach(() => w.reset());

import { planDrafts, safes } from "@/server/db/schema";
const setLive = async (draftKey: string) => {
  const [{ id }] = await w.db.select({ id: safes.id }).from(safes).limit(1);
  const draft = { text: "$2,000", hfIdx: 1, months: 12, cash: 2000, msgId: "m1", draftKey, seen: ["m1"] };
  await w.db.insert(planDrafts).values({ safeId: id, draft }).onConflictDoUpdate({ target: planDrafts.safeId, set: { draft } });
};
const send = async (draftKey: string) => { await setLive(draftKey); return POST(w.req(`/api/safes/${MOCK_SAFE}/proposals`, { method: "POST", cookie, json: { draftKey, chainId: 8453, cash: 2000, hfIdx: 1 } }), params); };

describe("propose a batch as a delegate", () => {
  it("is visible through the service with our hash, proposed by the agent, a MultiSend call", async () => {
    const res = await send("d1");
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.stage).toBe("queued");
    expect(out.receipt).toMatch(/^Sent to your Safe:/);

    const [row] = await w.db.select().from(proposals);
    const live = await new SafeServiceClient({ baseUrl: "http://safe.test", fetch: ((u: string, i?: RequestInit) => w.services.fakes.get(8453)!.handler(new Request(u, i))) as typeof fetch })
      .getMultisigTransaction(row.safeTxHash as Hex);
    expect(live).not.toBeNull();
    expect(live!.safeTxHash.toLowerCase()).toBe(row.safeTxHash);
    expect(live!.proposedByDelegate?.toLowerCase()).toBe(w.services.signer.address.toLowerCase());
    expect(live!.operation).toBe(1);
    expect(live!.to.toLowerCase()).toBe(MULTISEND_CALL_ONLY.toLowerCase());
    expect(live!.confirmations).toHaveLength(0);
  });

  it.each([
    { visibility: "immediately", firstStage: "queued" },
    { visibility: "after a delay", firstStage: "sending" },
  ])("submits once when the response is lost and the hash is visible $visibility", async ({ firstStage }) => {
    loseNextPostResponse = true;
    hideTransaction = firstStage === "sending";
    const firstResponse = await send("d2");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.stage).toBe(firstStage);
    expect(posts).toBe(1);
    expect(loseNextPostResponse).toBe(false);

    const [before] = await w.db.select().from(proposals);
    expect(before).toMatchObject({ id: first.proposalId, stage: firstStage, nonce: 0n, submissionAttemptedAt: expect.any(Date) });
    expect(await w.services.fakes.get(8453)!.getMultisigTransaction(before.safeTxHash as Hex)).toMatchObject({ nonce: 0 });

    hideTransaction = false;
    const again = await (await send("d2")).json();
    expect(again).toMatchObject({ proposalId: first.proposalId, stage: "queued" });
    expect(posts).toBe(1);
    expect(await w.db.select().from(proposals)).toMatchObject([{
      id: before.id, stage: "queued", nonce: before.nonce, safeTxHash: before.safeTxHash, submissionAttemptedAt: before.submissionAttemptedAt,
    }]);
    expect(await w.db.select().from(activity)).toMatchObject([{ proposalId: before.id, kind: "proposed" }]);
  });

  it("answers 409 when the agent is not on the Safe, and 422 when the amount is too small", async () => {
    expect((await POST(w.req("/x", { method: "POST", cookie, json: { draftKey: "s", chainId: 8453, cash: 5 } }), params)).status).toBe(422);
    w.services.fakes.get(8453)!.reset();
    w.services.fakes.get(8453)!.setOwners(SAFE, [MOCK_OWNER], 1);
    expect((await send("d3")).status).toBe(409);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });
});
