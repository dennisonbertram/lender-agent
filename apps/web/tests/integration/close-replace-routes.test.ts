// BP-24 and BP-26 through the routes: the close route and Send with `replaces`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POST as CLOSE } from "@/app/api/safes/[address]/loans/[loanId]/close/route";
import { POST as SEND } from "@/app/api/safes/[address]/proposals/route";
import { messages, planDrafts, proposals, safes } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import type { Hex, LoanPosition } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../helpers/world";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const LOAN = `8453:${SAFE.toLowerCase()}:aave-v3`;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
let w: TestWorld;
const closeParams = { params: Promise.resolve({ address: MOCK_SAFE, loanId: encodeURIComponent(LOAN) }) };
const sendParams = { params: Promise.resolve({ address: MOCK_SAFE }) };

beforeEach(async () => {
  w = await createTestWorld();
  await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await w.services.fakes.get(8453)!.addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
});
afterEach(() => w.reset());

const position = (): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: LOAN,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }], debt: [{ asset: "USDC", token: USDC, amount: 2000, usd: 2000 }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n,
});

describe("close route", () => {
  it("not enough USDC: 422 with the sentence, nothing stored and no card", async () => {
    w.services.fixture.setPosition(8453, SAFE, position());
    w.services.fixture.setBalances(8453, SAFE, { USDC: 1200 });
    const { cookie } = await w.signIn(MOCK_OWNER);
    const res = await CLOSE(w.req("/", { method: "POST", cookie }), closeParams);
    expect(res.status).toBe(422);
    expect((await res.json()).line).toMatch(/Add \$80\d(\.\d\d)? more USDC/);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    expect(await w.db.select().from(messages)).toHaveLength(0);
  });

  it("queues the close and puts its card in the thread once, also when asked twice", async () => {
    w.services.fixture.setPosition(8453, SAFE, position());
    w.services.fixture.setBalances(8453, SAFE, { USDC: 2500 });
    const { cookie } = await w.signIn(MOCK_OWNER);
    const a = await (await CLOSE(w.req("/", { method: "POST", cookie }), closeParams)).json();
    const b = await (await CLOSE(w.req("/", { method: "POST", cookie }), closeParams)).json();
    expect(a.stage).toBe("queued");
    expect(a.receipt).toBe("Sent to your Safe: Close Aave v3 loan.");
    expect(b.proposalId).toBe(a.proposalId);
    expect(await w.db.select().from(messages)).toHaveLength(1);
  });

  it("an unknown or foreign loan id is 404", async () => {
    const { cookie } = await w.signIn(MOCK_OWNER);
    for (const id of [`8453:${SAFE.toLowerCase()}:nope`, `8453:0x00000000000000000000000000000000000000b2:aave-v3`, "8453"]) {
      const res = await CLOSE(w.req("/", { method: "POST", cookie }), { params: Promise.resolve({ address: MOCK_SAFE, loanId: encodeURIComponent(id) }) });
      expect(res.status).toBe(404);
    }
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it("a stranger is refused", async () => {
    const { cookie } = await w.signIn(MOCK_STRANGER);
    const res = await CLOSE(w.req("/", { method: "POST", cookie }), closeParams);
    expect(res.status).toBe(403);
  });
});

describe("Send with `replaces`", () => {
  it("replaces the open proposal: the old row reads replaced, the new one is queued, one card each", async () => {
    const { cookie } = await w.signIn(MOCK_OWNER);
    const [{ id: safeId }] = await w.db.select({ id: safes.id }).from(safes).limit(1);
    const live = (draftKey: string, cash: number) => {
      const draft = { text: `$${cash}`, hfIdx: 1, months: 12, cash, msgId: "m1", draftKey, seen: ["m1"] };
      return w.db.insert(planDrafts).values({ safeId, draft }).onConflictDoUpdate({ target: planDrafts.safeId, set: { draft } });
    };
    await live("d1", 2000);
    const first = await (await SEND(w.req("/", { method: "POST", cookie, json: { draftKey: "d1", cash: 2000, hfIdx: 1 } }), sendParams)).json();
    await live("d2", 3000);
    const second = await (await SEND(w.req("/", { method: "POST", cookie, json: { draftKey: "d2", cash: 3000, hfIdx: 1, replaces: first.proposalId } }), sendParams)).json();
    expect(second.stage).toBe("queued");
    expect(second.replacedId).toBe(first.proposalId);
    expect(second.oldStillInSafe).toBe(false);
    const [old] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(old).toMatchObject({ stage: "replaced", replacedBy: second.proposalId });
    expect(await w.db.select().from(messages)).toHaveLength(2);
  });

  it("an edit-intent send without `replaces` is refused (409) while an open proposal exists; with none open it is an ordinary send", async () => {
    const { cookie } = await w.signIn(MOCK_OWNER);
    const [{ id: safeId }] = await w.db.select({ id: safes.id }).from(safes).limit(1);
    const live = (draftKey: string, cash: number) => {
      const draft = { text: `$${cash}`, hfIdx: 1, months: 12, cash, msgId: "m1", draftKey, seen: ["m1"] };
      return w.db.insert(planDrafts).values({ safeId, draft }).onConflictDoUpdate({ target: planDrafts.safeId, set: { draft } });
    };
    await live("d0", 1000);
    const ok = await SEND(w.req("/", { method: "POST", cookie, json: { draftKey: "d0", cash: 1000, hfIdx: 1, intent: "edit" } }), sendParams);
    expect(ok.status).toBe(200);
    await live("d1", 2000);
    const res = await SEND(w.req("/", { method: "POST", cookie, json: { draftKey: "d1", cash: 2000, hfIdx: 1, intent: "edit" } }), sendParams);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/replace/i);
    expect(await w.db.select().from(proposals)).toHaveLength(1);
  });
});
