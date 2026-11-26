// A loan on Arbitrum end to end on an Arbitrum fork: plan (quote route) → Test run → Send → queued, Aave v3 like Base.
// An owner of the Safe on Base only is refused for the Arbitrum plan (G4).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POST as QUOTE } from "@/app/api/safes/[address]/quote/route";
import { POST as SEND } from "@/app/api/safes/[address]/proposals/route";
import { GET as COMPARE } from "@/app/api/safes/[address]/blocks/compare/route";
import { GET as GET_CASH } from "@/app/api/safes/[address]/get-cash/route";
import { GET as WHATIF } from "@/app/api/safes/[address]/blocks/whatif/route";
import { setPublicClientForTests } from "@/server/chain/client";
import { createViemReader } from "@/server/chain/reader";
import { planDrafts, proposals } from "@/server/db/schema";
import { chainTestRunDeps } from "@/server/proposals/test-run";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_STRANGER } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { setServicesForTests } from "@/server/services";
import type { Address } from "@/shared/types";
import type { Fork } from "../helpers/anvil";
import { startFork } from "../helpers/multi-fork";
import { deployTestSafe } from "../helpers/safe";
import { createTestWorld, type TestWorld } from "../helpers/world";

const CHAIN = 42161 as const;
let fork: Fork;
let w: TestWorld;
let safe: Address;
let cookie: string;
const params = () => ({ params: Promise.resolve({ address: safe }) });

beforeAll(async () => {
  fork = await startFork(CHAIN) as unknown as Fork;
  setPublicClientForTests(CHAIN, fork.publicClient as never);
  w = await createTestWorld();
  const d = await deployTestSafe({ fork, owners: [MOCK_OWNER], threshold: 1, saltNonce: "4242" });
  safe = d.address;
  await fork.testClient.setBalance({ address: safe, value: parseEther("10") });
  await w.trackSafe(safe, { chainIds: [CHAIN], agentAdded: true });
  w.services.fixture.setOwners(CHAIN, safe, [MOCK_OWNER], 1);
  w.services.fakes.get(CHAIN)!.setOwners(safe, [MOCK_OWNER], 1);
  setServicesForTests({ ...w.services, reader: createViemReader(), testRunDeps: chainTestRunDeps });
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(CHAIN, w.services.signer.address));
  await w.services.fakes.get(CHAIN)!.addDelegate({ safe, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  cookie = (await w.signIn(MOCK_OWNER)).cookie;
}, 240_000);
afterAll(async () => {
  setPublicClientForTests(CHAIN, undefined);
  w?.reset();
  await fork?.stop();
});

describe("a loan on Arbitrum", () => {
  it("plans on Arbitrum with a passing Test run, and Send queues it on Arbitrum", async () => {
    const res = await QUOTE(w.req("/", { method: "POST", cookie, json: { cash: 5000, asset: "ETH", network: "arbitrum", messageId: "m1" } }), params());
    expect(res.status).toBe(200);
    const q = await res.json();
    expect(q.status).toBe("ok");
    expect(q.quote.network).toBe("Arbitrum");
    expect(q.quote.lender).toBe("Aave v3");
    expect(q.testRun.canSend).toBe(true);

    const [draft] = await w.db.select().from(planDrafts);
    const draftKey = (draft!.draft as { draftKey: string }).draftKey;
    const sent = await SEND(w.req("/", { method: "POST", cookie, json: { draftKey, chainId: CHAIN, cash: 5000, asset: "ETH", hfIdx: 1 } }), params());
    expect(sent.status).toBe(200);
    expect((await sent.json()).stage).toBe("queued");
    const [row] = await w.db.select().from(proposals);
    expect(row!.chainId).toBe(CHAIN);
  }, 120_000);

  it("compare, Get cash and what-if read Arbitrum", async () => {
    const cmp = await (await COMPARE(w.req("/?cash=3000&network=arbitrum", { cookie }), params())).json();
    expect(cmp.network).toBe("Arbitrum");
    expect(cmp.rows.some((r: { feasible: boolean }) => r.feasible)).toBe(true);
    const cash = await (await GET_CASH(w.req("/?network=arbitrum", { cookie }), params())).json();
    expect(cash.state).toBe("ok");
    expect(cash.holdings.length).toBeGreaterThan(0);
    const wi = await WHATIF(w.req("/?network=arbitrum", { cookie }), params());
    expect(wi.status).toBe(200);
  }, 120_000);

  it("an owner on Base only is refused the Arbitrum plan, compare, Get cash and what-if", async () => {
    w.services.fixture.setOwners(CHAIN, safe, [MOCK_OWNER, MOCK_COSIGNER], 1);
    await w.trackSafe("0x00000000000000000000000000000000000000c3", { chainIds: [8453, CHAIN] });
    const other = "0x00000000000000000000000000000000000000c3";
    w.services.fixture.setOwners(8453, other, [MOCK_STRANGER], 1);
    w.services.fixture.setOwners(CHAIN, other, [MOCK_OWNER], 1);
    const c = (await w.signIn(MOCK_STRANGER)).cookie;
    const p = { params: Promise.resolve({ address: other }) };
    expect((await QUOTE(w.req("/", { method: "POST", cookie: c, json: { cash: 1000, asset: "ETH", network: "arbitrum" } }), p)).status).toBe(403);
    expect((await COMPARE(w.req("/?cash=1000&network=arbitrum", { cookie: c }), p)).status).toBe(403);
    expect((await GET_CASH(w.req("/?network=arbitrum", { cookie: c }), p)).status).toBe(403);
    expect((await WHATIF(w.req("/?network=arbitrum", { cookie: c }), p)).status).toBe(403);
  });
});
