// BP-35: add a network to a Safe from Settings, then add the agent there with the existing delegate flow.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { safeNetworks } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { GET as STATUS, POST as ADD_AGENT } from "@/app/api/safes/[address]/agent/route";
import { POST as ADD_NETWORK } from "@/app/api/safes/[address]/networks/route";

const owner = privateKeyToAccount(MOCK_OWNER_KEY);
const params = { params: Promise.resolve({ address: MOCK_SAFE }) };
const URL_ = `/api/safes/${MOCK_SAFE}`;
let w: TestWorld;
let cookie: string;
let safeId: number;

const rows = async () => (await w.db.select().from(safeNetworks).where(eq(safeNetworks.safeId, safeId))).sort((a, b) => a.chainId - b.chainId);
const addNetwork = (chainId: unknown, c = cookie) => ADD_NETWORK(w.req(`${URL_}/networks`, { method: "POST", cookie: c, json: { chainId } }), params);

beforeEach(async () => {
  w = await createTestWorld();
  cookie = (await w.signIn(MOCK_OWNER)).cookie;
  safeId = await w.trackSafe(MOCK_SAFE, { chainIds: [8453] });
});
afterEach(() => w.reset());

describe("Add network", () => {
  it("adds a network where the Safe is not set up yet as ready on first use, with the agent off", async () => {
    const res = await addNetwork(42161);
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status.networks).toEqual([{ chainId: 8453, deployed: true, added: false }, { chainId: 42161, deployed: false, added: false }]);
    expect((await rows()).map((r) => [r.chainId, r.deployed, r.agentAdded])).toEqual([[8453, true, false], [42161, false, false]]);
  });
  it("marks it set up when the Safe already exists there, and the agent is then added with the same delegate flow", async () => {
    w.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
    w.services.fakes.get(42161)!.setOwners(MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
    const status = await (await addNetwork(42161)).json();
    expect(status.networks.find((n: { chainId: number }) => n.chainId === 42161)).toEqual({ chainId: 42161, deployed: true, added: false });
    const signature = await owner.signTypedData(delegateTypedData(42161, w.services.signer.address));
    const res = await ADD_AGENT(w.req(`${URL_}/agent`, { method: "POST", cookie, json: { chainId: 42161, signature } }), params);
    expect((await res.json()).networks.find((n: { chainId: number }) => n.chainId === 42161).added).toBe(true);
    expect(await w.services.fakes.get(42161)!.listDelegates(getAddress(MOCK_SAFE.toLowerCase()))).toHaveLength(1);
    expect(((await (await STATUS(w.req(`${URL_}/agent`, { cookie }), params)).json()).networks)).toHaveLength(2);
  });
  it("is idempotent, and refuses a network the app does not serve", async () => {
    expect((await addNetwork(42161)).status).toBe(200);
    expect((await addNetwork(42161)).status).toBe(200);
    expect(await rows()).toHaveLength(2);
    expect((await addNetwork(10)).status).toBe(400);
    expect((await addNetwork("base")).status).toBe(400);
    expect(await rows()).toHaveLength(2);
  });
  it("needs a signed-in owner", async () => {
    const stranger = (await w.signIn("0x90F79bf6EB2c4f870365E785982E1f101E93b906")).cookie;
    expect((await addNetwork(42161, stranger)).status).toBe(403);
    expect(await rows()).toHaveLength(1);
  });
});
