import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { safeContext } from "@/server/request";
import { createTestWorld, type TestWorld } from "../helpers/world";

describe("safeContext (G4)", () => {
  let world: TestWorld;
  beforeEach(async () => { world = await createTestWorld(); await world.trackSafe(MOCK_SAFE); });
  afterEach(() => world.reset());

  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);

  it("lets an owner and a co-signer in, with chat", async () => {
    for (const w of [MOCK_OWNER, MOCK_COSIGNER]) {
      const { cookie } = await world.signIn(w);
      const ctx = await safeContext(world.req("/x", { cookie }), MOCK_SAFE);
      expect(ctx.access.chat).toBe(true);
    }
  });

  it("answers 401 signed out, 403 for a stranger, 404 for an untracked Safe, 400 for a bad address", async () => {
    expect(await status(safeContext(world.req("/x"), MOCK_SAFE))).toBe(401);
    const { cookie } = await world.signIn(MOCK_STRANGER);
    expect(await status(safeContext(world.req("/x", { cookie }), MOCK_SAFE))).toBe(403);
    expect(await status(safeContext(world.req("/x", { cookie }), "0x0000000000000000000000000000000000000009"))).toBe(404);
    expect(await status(safeContext(world.req("/x", { cookie }), "0x123"))).toBe(400);
  });

  it("drops access when the owner is removed on-chain", async () => {
    const { cookie } = await world.signIn(MOCK_COSIGNER);
    world.services.fixture.setOwners(8453, MOCK_SAFE, [MOCK_OWNER], 1);
    expect(await status(safeContext(world.req("/x", { cookie }), MOCK_SAFE))).toBe(403);
  });
});
