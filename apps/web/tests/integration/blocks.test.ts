import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as greeting } from "@/app/api/safes/[address]/blocks/greeting/route";
import { GET as status } from "@/app/api/safes/[address]/blocks/status/route";
import { GET as holdings } from "@/app/api/safes/[address]/blocks/holdings/route";
import { GET as addfunds } from "@/app/api/safes/[address]/blocks/addfunds/route";
import { GET as explain } from "@/app/api/safes/[address]/blocks/explain/route";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { createTestWorld, type TestWorld } from "../helpers/world";

let world: TestWorld;
beforeEach(async () => {
  world = await createTestWorld();
  world.services.fixture.setOwners(8453, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  world.services.fixture.setBalances(8453, MOCK_SAFE, { ETH: 2.5 });
  await world.trackSafe(MOCK_SAFE);
});
afterEach(() => world.reset());

const params = { params: Promise.resolve({ address: MOCK_SAFE }) };
const routes = { greeting, status, holdings, addfunds, explain: (r: Request, p: typeof params) => explain(r, p) };

describe("block routes", () => {
  for (const [name, handler] of Object.entries(routes)) {
    it(`${name}: figures with a block number; strangers get 403`, async () => {
      const url = `/api/safes/${MOCK_SAFE}/blocks/${name}${name === "explain" ? "?topic=how" : ""}`;
      const owner = await world.signIn(MOCK_OWNER);
      const res = await handler(world.req(url, { cookie: owner.cookie }), params);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.blockNumber).toBeGreaterThan(0);
      expect(body.readAt).toBeGreaterThan(0);
      const stranger = await world.signIn(MOCK_STRANGER);
      expect((await handler(world.req(url, { cookie: stranger.cookie }), params)).status).toBe(403);
    });
  }
  it("greeting carries the live maximum; explain rejects an unknown topic", async () => {
    const { cookie } = await world.signIn(MOCK_OWNER);
    const g = await (await greeting(world.req(`/x`, { cookie }), params)).json();
    expect(g.max).toBeGreaterThan(500);
    expect(g.chips).toHaveLength(3);
    expect((await explain(world.req(`/x?topic=nope`, { cookie }), params)).status).toBe(400);
  });
});
