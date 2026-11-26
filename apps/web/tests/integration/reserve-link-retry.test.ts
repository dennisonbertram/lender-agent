// BP-39: a retry while the setup is still pending reuses it; two executed setups cannot happen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { privateKeyToAccount } from "viem/accounts";
import { delegateTypedData } from "@/server/safe/hash";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { proposals, reserveLinks } from "@/server/db/schema";
import { safeContext } from "@/server/request";
import { linkReserve } from "@/server/reserve";
import { refreshProposal } from "@/server/proposals/follow";
import type { Address, Hex } from "@/shared/types";

const MAIN = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const RESERVE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0009" as Address;
let w: TestWorld;
const ctxOf = async () => safeContext(w.req("/", { cookie: (await w.signIn(MOCK_OWNER)).cookie }), MAIN, w.services);
const input = { chainId: 8453 as const, reserveSafe: RESERVE, dailyLimitUsd: 500, triggerHf: 1.3 };
const links = () => w.db.select().from(reserveLinks);

beforeEach(async () => {
  process.env.MOCK = "1";
  w = await createTestWorld();
  await w.trackSafe(MAIN, { agentAdded: true });
  const fx = w.services.fixture;
  const fake = w.services.fakes.get(8453)!;
  fx.setOwners(8453, RESERVE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  fake.setOwners(RESERVE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  fx.setBalances(8453, RESERVE, { ETH: 0, USDC: 20_000 });
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake.addDelegate({ safe: RESERVE, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
});
afterEach(() => { delete process.env.MOCK; w.reset(); });

describe("linkReserve retries", () => {
  it("reuses the pending setup: same proposal, same salt, same module", async () => {
    const a = await linkReserve(await ctxOf(), input);
    const b = await linkReserve(await ctxOf(), input);
    expect(b.roles).toBe(a.roles);
    expect(await w.db.select().from(proposals).where(eq(proposals.safeId, (await links())[0]!.reserveSafeId))).toHaveLength(1);
    expect((await links())[0]).toMatchObject({ attempt: 0, state: "pending" });
  });

  it("refuses a different setup while the old one is still queued", async () => {
    await linkReserve(await ctxOf(), input);
    await expect(linkReserve(await ctxOf(), { ...input, dailyLimitUsd: 800 })).rejects.toMatchObject({ status: 409 });
  });

  it("promotes the link to linked when the setup executes", async () => {
    await linkReserve(await ctxOf(), input);
    const [l] = await links();
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, l!.setupProposalId!));
    w.services.fakes.get(8453)!.markExecuted(p!.safeTxHash as Hex, { success: true, txHash: `0x${"ab".repeat(32)}` });
    await refreshProposal(w.db, w.services, p!.id);
    expect((await links())[0]!.state).toBe("linked");
    await expect(linkReserve(await ctxOf(), input)).rejects.toMatchObject({ status: 409 });
  });
});
