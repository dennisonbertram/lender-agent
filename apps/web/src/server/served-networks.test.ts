// A Safe can be created on networks the app does not serve (Ethereum, Optimism, ...). Those rows are recorded for the
// creation flow only: every read, access check and agent step works on Base and Arbitrum alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { safeNetworks, safes } from "@/server/db/schema";
import { listSafesForWallet } from "@/server/auth/access";
import { agentStatus } from "@/server/agent-role";
import { addSafeNetwork } from "@/server/networks";
import { MOCK_OWNER, MOCK_SAFE } from "@/server/mock/seed";
import { safeContext } from "@/server/request";
import { safeSummary } from "@/server/safes";
import type { ChainId } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../tests/helpers/world";

let w: TestWorld;
let cookie: string;
let userId: number;
const asked: number[] = [];

beforeEach(async () => {
  w = await createTestWorld();
  ({ cookie, userId } = await w.signIn(MOCK_OWNER));
  asked.length = 0;
  // The app has no client for a network it does not serve: reading one throws, as rpcUrl does.
  for (const m of ["readSafeOwners", "readSafeThreshold", "readBalances"] as const) {
    const real = (w.services.reader[m] as (...a: unknown[]) => Promise<unknown>).bind(w.services.reader);
    (w.services.reader as unknown as Record<string, unknown>)[m] = (chainId: number, ...rest: unknown[]) => {
      asked.push(chainId);
      if (![8453, 42161].includes(chainId)) throw new Error(`no chain config for ${chainId}`);
      return real(chainId, ...rest);
    };
  }
});
afterEach(() => { vi.restoreAllMocks(); w.reset(); });

describe("a Safe created on [1, 8453]", () => {
  beforeEach(async () => {
    const id = await w.trackSafe(MOCK_SAFE, { chainIds: [1, 8453] as unknown as ChainId[], userId });
    await w.db.update(safes).set({ setup: { owners: [MOCK_OWNER], threshold: 1 } }).where(eq(safes.id, id));
  });

  it("safeContext, the Safe list, the summary and the agent step work and only touch Base", async () => {
    const ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
    expect(ctx.networks.map((n) => n.chainId)).toEqual([8453]);
    expect(ctx.access.trackedChainIds).toEqual([8453]);
    const list = await listSafesForWallet(w.db, w.services.access, userId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ networks: [8453], ownedChainIds: [8453] });
    expect((await safeSummary(ctx)).chainIds).toEqual([8453]);
    const status = await agentStatus(ctx);
    expect(status.networks.map((n) => n.chainId)).toEqual([8453]);
    expect(status.otherChainIds).toEqual([1]);
    expect(asked.every((c) => c === 8453)).toBe(true);
  });

  it("limits agent eligibility to owned deployed networks and excludes a pending off-lending setup", async () => {
    const ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
    await w.db.insert(safeNetworks).values({ safeId: ctx.safe.id, chainId: 42161, deployed: true, agentAdded: false });
    await w.db.update(safeNetworks).set({ deployed: false }).where(eq(safeNetworks.chainId, 1));
    ctx.access = { ...ctx.access, ownedChainIds: [8453], trackedChainIds: [8453, 42161], chat: false, ownersDiffer: true };

    const status = await agentStatus(ctx);

    expect(status).toMatchObject({ eligibleChainIds: [8453], canChat: false, otherChainIds: [] });
  });

  it("adding Arbitrum through the networks flow gives an agent step with both served networks", async () => {
    const ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
    const status = await addSafeNetwork(ctx, 42161);
    expect(status.networks.map((n) => n.chainId)).toEqual([8453, 42161]);
    await expect(addSafeNetwork(ctx, 1)).rejects.toMatchObject({ status: 400 });
  });
});

describe("a Safe created only on Optimism [10]", () => {
  beforeEach(async () => {
    const id = await w.trackSafe(MOCK_SAFE, { chainIds: [10] as unknown as ChainId[], userId });
    await w.db.update(safes).set({ setup: { owners: [MOCK_OWNER], threshold: 1 } }).where(eq(safes.id, id));
    w.services.access.readSetupOwners = async (chainId) => chainId === 10 ? [MOCK_OWNER] : null;
  });

  it("does not throw: the creator is listed, the agent step says what to do, nothing is read on Optimism", async () => {
    const list = await listSafesForWallet(w.db, w.services.access, userId);
    expect(list).toEqual([expect.objectContaining({ networks: [], ownedChainIds: [], verifiedChainIds: [10], agent: false })]);
    const ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
    const status = await agentStatus(ctx);
    expect(status).toMatchObject({ networks: [], active: false, otherChainIds: [10] });
    expect(asked).not.toContain(10);
    await expect(safeSummary(ctx)).resolves.toMatchObject({ chainIds: [], ownedChainIds: [] });
  });

  it("add Base starts tracking it, and the agent step then offers Base", async () => {
    const ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
    const status = await addSafeNetwork(ctx, 8453);
    expect(status.networks.map((n) => n.chainId)).toEqual([8453]);
    expect((await w.db.select().from(safeNetworks).where(eq(safeNetworks.safeId, ctx.safe.id))).map((n) => n.chainId).sort()).toEqual([10, 8453]);
  });

  it("a stranger still gets 403", async () => {
    const other = await w.signIn("0x00000000000000000000000000000000000000c3");
    await expect(safeContext(w.req("/", { cookie: other.cookie }), MOCK_SAFE, w.services)).rejects.toMatchObject({ status: 403 });
  });

  it("a former setup signer cannot reopen a deployed setup-only Safe", async () => {
    w.services.access.readSetupOwners = async () => ["0x00000000000000000000000000000000000000c3"];
    expect(await listSafesForWallet(w.db, w.services.access, userId)).toEqual([]);
    await expect(safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services)).rejects.toMatchObject({ status: 403 });
  });
});

describe("verification of multiple off-lending setup networks", () => {
  beforeEach(async () => {
    const id = await w.trackSafe(MOCK_SAFE, { chainIds: [10, 100] as unknown as ChainId[], userId });
    await w.db.update(safes).set({ setup: { owners: [MOCK_OWNER], threshold: 1 } }).where(eq(safes.id, id));
    w.services.access.readSetupOwners = async (chainId) => chainId === 10 ? [MOCK_OWNER] : null;
  });

  it("lists only the off-lending network whose live owner read verified this wallet", async () => {
    const [listed] = await listSafesForWallet(w.db, w.services.access, userId);
    expect(listed).toMatchObject({ recordedChainIds: [10, 100], verifiedChainIds: [10] });
  });
});
