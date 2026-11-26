import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { proposals, planDrafts } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { execCalldata } from "@/server/safe/exec";
import { delegateTypedData, safeTxTypedData } from "@/server/safe/hash";
import { packSignatures, preValidatedSignature } from "@/server/safe/signature";
import { safeContext } from "@/server/request";
import { sendToSafe } from "@/server/proposals/send";
import type { Address, Hex, SafeTx } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../../../tests/helpers/world";
import { POST } from "./route";

const SAFE = getAddress(MOCK_SAFE.toLowerCase()) as Address;
const A = privateKeyToAccount(MOCK_OWNER_KEY);
const B = privateKeyToAccount(generatePrivateKey());
let w: TestWorld;
let tx: SafeTx;
let hash: Hex;

beforeEach(async () => {
  w = await createTestWorld();
  const safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const fake = w.services.fakes.get(8453)!;
  fake.setOwners(SAFE, [MOCK_OWNER, B.address], 2);
  const sig = await A.signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  const draft = { text: "$2,000", hfIdx: 1, months: 12, cash: 2000, msgId: "m1", draftKey: "d1", seen: ["m1"] };
  await w.db.insert(planDrafts).values({ safeId, draft });
  const ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
  await sendToSafe(ctx, { draftKey: "d1", chainId: 8453, cash: 2000, hfIdx: 1 });
  const [row] = await w.db.select().from(proposals);
  tx = row.tx as SafeTx;
  hash = row.safeTxHash as Hex;
});
afterEach(() => w.reset());

const sign = (acct: typeof A) => acct.signTypedData(safeTxTypedData(8453, SAFE, tx));
const call = (data: Hex, o: { to?: string; from?: string } = {}) =>
  POST(new Request("http://x/api/mock/safe-wallet", { method: "POST", body: JSON.stringify({ action: "execute-tx", chainId: 8453, data, to: o.to ?? SAFE, from: o.from ?? A.address }) }));
const both = async () => packSignatures([{ owner: A.address, signature: await sign(A) }, { owner: B.address, signature: await sign(B) }]);

describe("mock Safe{Wallet} execute-tx", () => {
  it("runs a fully valid call (two hash-bound signatures)", async () => {
    const res = await call(execCalldata(tx, await both()));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
  it("accepts v=1 for the sender plus one hash-bound signature", async () => {
    const sigs = packSignatures([{ owner: A.address, signature: preValidatedSignature(A.address) }, { owner: B.address, signature: await sign(B) }]);
    expect((await call(execCalldata(tx, sigs))).status).toBe(200);
  });
  it("rejects v=1 for someone other than the sender", async () => {
    const sigs = packSignatures([{ owner: A.address, signature: preValidatedSignature(A.address) }, { owner: B.address, signature: await sign(B) }]);
    expect((await call(execCalldata(tx, sigs), { from: B.address })).status).toBe(400);
  });
  it("rejects fewer signatures than the threshold", async () => {
    expect((await call(execCalldata(tx, await sign(A)))).status).toBe(400);
  });
  it("rejects a signature from a non-owner", async () => {
    const X = privateKeyToAccount(generatePrivateKey());
    const sigs = packSignatures([{ owner: A.address, signature: await sign(A) }, { owner: X.address, signature: await sign(X) }]);
    expect((await call(execCalldata(tx, sigs))).status).toBe(400);
  });
  it("rejects a signature over a different hash", async () => {
    const other = await B.signTypedData(safeTxTypedData(8453, SAFE, { ...tx, nonce: "999" }));
    const sigs = packSignatures([{ owner: A.address, signature: await sign(A) }, { owner: B.address, signature: other }]);
    expect((await call(execCalldata(tx, sigs))).status).toBe(400);
  });
  it("rejects a call addressed to another contract", async () => {
    expect((await call(execCalldata(tx, await both()), { to: "0x0000000000000000000000000000000000000bad" })).status).toBe(400);
  });
  it.each([["operation", { operation: 0 }], ["refundReceiver", { refundReceiver: "0x000000000000000000000000000000000000dEaD" }], ["gasPrice", { gasPrice: "1" }], ["safeTxGas", { safeTxGas: "5" }]])("rejects a changed %s", async (_n, patch) => {
    expect((await call(execCalldata({ ...tx, ...patch } as SafeTx, await both()))).status).toBe(404);
  });
  it("does not execute anything on rejection", async () => {
    await call(execCalldata(tx, await sign(A)));
    const live = await w.services.fakes.get(8453)!.getMultisigTransaction(hash);
    expect(live?.isExecuted).toBeFalsy();
  });
});
