// BP-29/BP-30 through the route handlers in the MOCK world: preview -> sign -> create -> setup -> agent step is next.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { POST as preview } from "@/app/api/safes/create/preview/route";
import { POST as create } from "@/app/api/safes/create/route";
import { GET as status, POST as setup } from "@/app/api/safes/[address]/setup/route";
import { GET as agentStatusRoute } from "@/app/api/safes/[address]/agent/route";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_STRANGER } from "@/server/mock/seed";
import { createTestWorld, type TestWorld } from "../helpers/world";

let world: TestWorld;
beforeEach(async () => { world = await createTestWorld(); });
afterEach(() => { world.reset(); delete process.env.SPONSOR_DAILY; });

const owner = privateKeyToAccount(MOCK_OWNER_KEY);
const params = (address: string) => ({ params: Promise.resolve({ address }) });
const draft = { name: "My Safe", cosigners: [MOCK_COSIGNER], threshold: 1 };

async function review(cookie: string) {
  return (await preview(world.req("/api/safes/create/preview", { method: "POST", cookie, json: draft }))).json();
}
async function createIt(cookie: string, pv: { index: number; message: string }) {
  const signature = await owner.signMessage({ message: pv.message });
  return create(world.req("/api/safes/create", { method: "POST", cookie, json: { ...draft, index: pv.index, signature } }));
}

describe("create and set up through the routes", () => {
  it("Review address = created address = deployed address; setup is sponsored, then the app waits for the index", async () => {
    const { cookie } = await world.signIn(MOCK_OWNER);
    const pv = await review(cookie);
    expect(pv.sponsored).toBe(true);
    expect(pv.cost).toMatch(/free/i);
    const res = await createIt(cookie, pv);
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made.address).toBe(pv.address);

    const before = await (await status(world.req(`/api/safes/${made.address}/setup?chainId=8453`, { cookie }), params(made.address))).json();
    expect(before).toEqual({ deployed: false, indexed: false });
    const r = await (await setup(world.req(`/api/safes/${made.address}/setup`, { method: "POST", cookie, json: { chainId: 8453 } }), params(made.address))).json();
    expect(r).toMatchObject({ status: "ready", deployed: "by_relayer", indexed: true });
    expect(await (await status(world.req(`/api/safes/${made.address}/setup?chainId=8453`, { cookie }), params(made.address))).json()).toEqual({ deployed: true, indexed: true });
    // now the Safe is on chain: the normal agent step works, and it is not added yet
    const agent = await (await agentStatusRoute(world.req(`/api/safes/${made.address}/agent`, { cookie }), params(made.address))).json();
    expect(agent).toBeTruthy();
    // second call: nothing more is sent
    expect(await (await setup(world.req(`/api/safes/${made.address}/setup`, { method: "POST", cookie, json: { chainId: 8453 } }), params(made.address))).json()).toMatchObject({ deployed: "already" });
  });

  it("with the budget at zero the review and setup state the fee and never say free", async () => {
    process.env.SPONSOR_DAILY = "0";
    const { cookie } = await world.signIn(MOCK_OWNER);
    const pv = await review(cookie);
    expect(pv.sponsored).toBe(false);
    expect(pv.cost).not.toMatch(/free/i);
    expect(pv.cost).toMatch(/one-time/);
    const made = await (await createIt(cookie, pv)).json();
    const r = await (await setup(world.req(`/api/safes/${made.address}/setup`, { method: "POST", cookie, json: { chainId: 8453 } }), params(made.address))).json();
    expect(r.status).toBe("user_pays");
    expect(r.cost).not.toMatch(/free/i);
    expect(r.tx.to).toBe("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67");
  });

  it("needs a session, rejects a forged signature, and hides the Safe from strangers", async () => {
    expect((await preview(world.req("/api/safes/create/preview", { method: "POST", json: draft }))).status).toBe(401);
    const { cookie } = await world.signIn(MOCK_OWNER);
    const pv = await review(cookie);
    const stranger = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
    const bad = await create(world.req("/api/safes/create", { method: "POST", cookie, json: { ...draft, index: pv.index, signature: await stranger.signMessage({ message: pv.message }) } }));
    expect(bad.status).toBe(400);
    const made = await (await createIt(cookie, pv)).json();
    const s = await world.signIn(MOCK_STRANGER);
    expect((await setup(world.req(`/api/safes/${made.address}/setup`, { method: "POST", cookie: s.cookie, json: { chainId: 8453 } }), params(made.address))).status).toBe(404);
  });

  it("a network that is not a Safe network is refused", async () => {
    const { cookie } = await world.signIn(MOCK_OWNER);
    const pv = await review(cookie);
    const made = await (await createIt(cookie, pv)).json();
    const r = await setup(world.req(`/api/safes/${made.address}/setup`, { method: "POST", cookie, json: { chainId: 56 } }), params(made.address));
    expect(r.status).toBe(400);
  });

  it("the preview gives one fee line per chosen network, in order; Ethereum is never free", async () => {
    const { cookie } = await world.signIn(MOCK_OWNER);
    const pv = await (await preview(world.req("/api/safes/create/preview", { method: "POST", cookie, json: { ...draft, networks: [8453, 1, 100] } }))).json();
    expect(pv.networks.map((n: { chainId: number }) => n.chainId)).toEqual([8453, 1, 100]);
    expect(pv.chainId).toBe(8453);
    const eth = pv.networks[1];
    expect(eth.sponsored).toBe(false);
    expect(eth.cost).toMatch(/Ethereum.*\$5 to \$16/);
    expect(pv.networks[2].cost).toMatch(/Gnosis/);
    expect(pv.address).toBe((await review(cookie)).address); // the address does not depend on the networks
  });
});
