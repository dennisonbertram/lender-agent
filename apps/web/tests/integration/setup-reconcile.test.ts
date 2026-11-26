import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { safeNetworks, relayerDeployments } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { previewSafe, createSafeRecord } from "@/server/safe-create/store";
import { POST as SETUP } from "@/app/api/safes/[address]/setup/route";
import { GET as AGENT } from "@/app/api/safes/[address]/agent/route";
import { POST as AGENT_TYPED } from "@/app/api/safes/[address]/agent/typed-data/route";
import { createTestWorld, type TestWorld } from "../helpers/world";

const owner = privateKeyToAccount(MOCK_OWNER_KEY);
let w: TestWorld;
let cookie: string;
let userId: number;
let address: string;
const params = (safe: string) => ({ params: Promise.resolve({ address: safe }) });

beforeEach(async () => {
  w = await createTestWorld();
  ({ cookie, userId } = await w.signIn(MOCK_OWNER));
  const draft = { name: "Recovered Safe", cosigners: [], threshold: 1 };
  const preview = await previewSafe(w.db, { creator: owner.address, ...draft });
  const signature = await owner.signMessage({ message: preview.message });
  const safe = await createSafeRecord(w.db, { userId, creator: owner.address, ...draft, index: preview.index, signature, networks: [8453] });
  address = safe.address;
  // Model a confirmed setup transaction whose browser response was lost: chain and service see the Safe,
  // while the server's deployment ledger still has its initial false value.
  w.services.fixture.setOwners(8453, safe.address, safe.setup.owners, safe.setup.threshold);
  w.services.fakes.get(8453)!.setOwners(safe.address, safe.setup.owners, safe.setup.threshold);
});

afterEach(() => w.reset());

describe("setup reconciliation after a lost wallet response", () => {
  it("records a verified deployment idempotently so the real agent status route can offer a signature", async () => {
    const path = `/api/safes/${address}/setup`;
    const reconcile = () => SETUP(w.req(path, { method: "POST", cookie, json: { chainId: 8453, reconcile: true } }), params(address));
    const first = await reconcile();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "ready", deployed: "already", indexed: true });
    expect(await reconcile().then((r) => r.json())).toMatchObject({ status: "ready", deployed: "already", indexed: true });

    const [row] = await w.db.select().from(safeNetworks).where(eq(safeNetworks.chainId, 8453));
    expect(row.deployed).toBe(true);
    expect(await w.db.select().from(relayerDeployments)).toHaveLength(0);

    const statusResponse = await AGENT(w.req(`/api/safes/${address}/agent`, { cookie }), params(address));
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ networks: [{ chainId: 8453, deployed: true, added: false }] });
    const typed = await AGENT_TYPED(w.req(`/api/safes/${address}/agent/typed-data`, { method: "POST", cookie, json: { chainId: 8453 } }), params(address));
    expect(typed.status).toBe(200);
  });

  it("does not deploy or offer a fee when the chain does not confirm the Safe code", async () => {
    w.services.fixture.removeSafe(8453, address as `0x${string}`);
    const response = await SETUP(w.req(`/api/safes/${address}/setup`, { method: "POST", cookie, json: { chainId: 8453, reconcile: true } }), params(address));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "not_deployed" });
    const [row] = await w.db.select().from(safeNetworks).where(eq(safeNetworks.chainId, 8453));
    expect(row.deployed).toBe(false);
    expect(await w.db.select().from(relayerDeployments)).toHaveLength(0);
  });
});
