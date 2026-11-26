import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { clearReserveCache, reservePolicy, reserveStatus } from "./index";
import { checkReserve, linkReserve } from "./link";
import { reserveViewOf } from "./view";

// MOCK=1 path: no RPC. The mock world's Reserve Safe holds $2,500 and was "signed as designed".
const MAIN = "0x1111111111111111111111111111111111111111" as Address;
const RESERVE = "0x2222222222222222222222222222222222222222" as Address;
let w: TestWorld;
beforeEach(() => { process.env.MOCK = "1"; clearReserveCache(); });
afterEach(() => { w?.reset(); delete process.env.MOCK; });

async function ctx(opts: { name?: string; agentOnReserve?: boolean } = {}) {
  w = await createTestWorld();
  await w.trackSafe(MAIN, { name: opts.name ?? "Treasury Safe", agentAdded: true });
  const fake = w.services.fakes.get(8453)!;
  for (const s of [MAIN, RESERVE]) {
    fake.setOwners(s, [MOCK_OWNER], 1);
    w.services.fixture.setOwners(8453, s, [MOCK_OWNER], 1);
    const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
    if (s === RESERVE && opts.agentOnReserve === false) continue;
    await fake.addDelegate({ safe: s, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
  }
  w.services.fixture.setBalances(8453, RESERVE, { USDC: 2500 });
  const { cookie } = await w.signIn(MOCK_OWNER);
  return safeContext(w.req("/", { cookie }), MAIN, w.services);
}

describe("reserve status, mock path", () => {
  it("is null while no Reserve is linked, on every surface's read", async () => {
    await ctx();
    expect(await reserveStatus({ address: MAIN, chainId: 8453 }, { db: w.db })).toBeNull();
    expect(await reservePolicy({ address: MAIN, chainId: 8453 }, { db: w.db })).toBeNull();
    expect(await reserveViewOf(await safeContext(w.req("/", { cookie: (await w.signIn(MOCK_OWNER)).cookie }), MAIN, w.services), 8453)).toMatchObject({ available: true, linked: false, status: null });
  });
  it("is not available on a network without the Reserve", async () => {
    expect(await reserveViewOf(await ctx(), 84532)).toMatchObject({ available: false, linked: false });
  });
  it("after linking, one view for page, sidebar and chat: On, limit, used, left, with the setup waiting in the Reserve Safe queue", async () => {
    const c = await ctx();
    await reserveViewOf(c, 8453); // primes the cache with "not linked"
    await linkReserve(c, { chainId: 8453, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 });
    const v = await reserveViewOf(c, 8453);
    expect(v.linked).toBe(true);
    expect(v.status).toMatchObject({ kind: "armed", label: "On", limitUsd: 1000, usedUsd: 0, leftUsd: 1000, triggerHf: 1.2 });
    expect(v.policy!.copy.can.join(" ")).toContain("up to $1,000");
    expect(v.setup).toBeNull(); // the mock chain shows it as signed, so nothing is waiting
    // the addresses the owners sign for: pool and USDC come from the Reserve constants
    expect(v.policy!.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(v.policy!.usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
  it("returns the Reserve Safe's owners and whether the viewer is one", async () => {
    const c = await ctx();
    await linkReserve(c, { chainId: 8453, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 });
    const v = await reserveViewOf(c, 8453);
    expect(v.reserveOwners?.map((o) => o.toLowerCase())).toEqual([MOCK_OWNER.toLowerCase()]);
    expect(v.viewerIsReserveOwner).toBe(true);
    // a viewer who is not among the Reserve Safe's owners
    w.services.fixture.setOwners(8453, RESERVE, ["0x9999999999999999999999999999999999999999" as Address], 1);
    w.services.fakes.get(8453)!.setOwners(RESERVE, ["0x9999999999999999999999999999999999999999" as Address], 1);
    const other = await reserveViewOf(c, 8453);
    expect(other.viewerIsReserveOwner).toBe(false);
    expect(other.reserveOwners).toHaveLength(1);
  });
  it("omits owners while no Reserve Safe is linked", async () => {
    const v = await reserveViewOf(await ctx(), 8453);
    expect(v.reserveOwners).toBeUndefined();
    expect(v.viewerIsReserveOwner).toBeUndefined();
  });
  it("names an unnamed Safe by its short address, never a blank", async () => {
    const c = await ctx({ name: "" });
    await linkReserve(c, { chainId: 8453, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 });
    const { policy } = await reserveViewOf(c, 8453);
    const lines = [...policy!.copy.can, ...policy!.copy.cannot];
    expect(policy!.copy.can[0]).toMatch(/^Repay 0x1111…1111's/);
    for (const l of lines) { expect(l).not.toContain(" 's"); expect(l.endsWith("even to ")).toBe(false); }
  });
  it("checkReserve says the agent is missing before the click, and still shows the balance", async () => {
    const c = await ctx({ agentOnReserve: false });
    const check = await checkReserve(c, { chainId: 8453, reserveSafe: RESERVE, dailyLimitUsd: 100, triggerHf: 1.2 });
    expect(check.errors.reserve).toBe("The Lender agent is not on this Safe yet. Add it first, then come back.");
    expect(check.balanceUsd).toBe(2500);
  });
});
