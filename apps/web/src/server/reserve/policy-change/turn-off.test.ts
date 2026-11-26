import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listActivity } from "@/server/activity";
import { HttpError } from "@/server/http";
import { MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../../tests/helpers/world";
import { clearReserveCache } from "../index";
import { linkReserve } from "../link";
import { reserveViewOf } from "../view";
import { OFF_BUT_NOT_SENT, turnReserveOff } from "./index";

const MAIN = "0x1111111111111111111111111111111111111111" as Address;
const RESERVE = "0x2222222222222222222222222222222222222222" as Address;
const ROW = "Turned the reserve off. The agent stopped using it.";
let w: TestWorld;
beforeEach(() => { process.env.MOCK = "1"; clearReserveCache(); });
afterEach(() => { w?.reset(); delete process.env.MOCK; });

async function linked() {
  w = await createTestWorld();
  await w.trackSafe(MAIN, { name: "Treasury Safe", agentAdded: true });
  const fake = w.services.fakes.get(8453)!;
  for (const s of [MAIN, RESERVE]) {
    fake.setOwners(s, [MOCK_OWNER], 1);
    w.services.fixture.setOwners(8453, s, [MOCK_OWNER], 1);
    const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
    await fake.addDelegate({ safe: s, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
  }
  w.services.fixture.setBalances(8453, RESERVE, { USDC: 2500 });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const c = await safeContext(w.req("/", { cookie }), MAIN, w.services);
  await linkReserve(c, { chainId: 8453, reserveSafe: RESERVE, dailyLimitUsd: 1000, triggerHf: 1.2 });
  return c;
}

describe("turn the reserve off", () => {
  it("never reports failure once the agent has stopped: Off at once, one activity row, safe to repeat", async () => {
    const c = await linked();
    expect((await reserveViewOf(c, 8453)).status?.label).toBe("On"); // primes the cache
    const rows = async () => (await listActivity(w.db, c.safe.id)).filter((a) => a.text === ROW);
    let result: unknown;
    let err: unknown;
    try { result = await turnReserveOff(c, 8453); } catch (e) { err = e; }
    if (err) { expect(err).toBeInstanceOf(HttpError); expect((err as HttpError).status).toBe(502); expect((err as HttpError).message).toBe(OFF_BUT_NOT_SENT); }
    else expect(result).toHaveProperty("sentence");
    expect((await reserveViewOf(c, 8453)).status?.label).toBe("Off");
    expect(await rows()).toHaveLength(1);
    await turnReserveOff(c, 8453).catch(() => {});
    expect(await rows()).toHaveLength(1);
  });
});
