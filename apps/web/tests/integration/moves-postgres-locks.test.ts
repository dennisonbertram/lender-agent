import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSafe, deposit } from "@/lib/networks";
import { proposals } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { setMoveDepsForTests, type MoveDeps } from "@/server/moves/deps";
import { chainOf, MOVE_NETWORKS } from "@/server/moves/networks";
import { planCrossNetwork } from "@/server/moves/plan";
import { draftMove, getMove, sendMove } from "@/server/moves/service";
import { fakeAggregator, fakeDestination } from "@/server/moves/testing";
import { reconcileAllSending } from "@/server/proposals/send";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import { newSafeSetup } from "@/server/safe/setup";
import type { Hex } from "@/shared/types";
import { BASE_PRICES, VENUES } from "../fixtures/legacy-data";
import { createPostgresLockWorld, waitForPostgresLockWait } from "../helpers/postgres-lock-db";
import { createTestWorld } from "../helpers/world";

it.skipIf(!process.env.PG_LOCK_TEST_URL)("commits the move link before a worker can reconcile its proposal", async () => {
  const pg = await createPostgresLockWorld();
  const world = await createTestWorld(pg.dbA);
  try {
    const safe = getAddress(MOCK_SAFE.toLowerCase());
    const safeId = await world.trackSafe(safe, {
      agentAdded: true,
      setup: newSafeSetup({ owners: [MOCK_OWNER, MOCK_COSIGNER], threshold: 2, saltNonce: "1" }),
    });
    const { cookie } = await world.signIn(MOCK_OWNER);
    const fake = world.services.fakes.get(8453)!;
    await fake.addDelegate({
      safe, delegate: world.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent",
      signature: await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, world.services.signer.address)),
    });
    const context = await safeContext(world.req("/", { cookie }), safe, world.services);
    const now = new Date("2026-11-14T10:00:00Z");
    const destination = fakeDestination();
    const aggregator = fakeAggregator({ now: () => now.getTime(), durationSec: 600 });
    const deps: MoveDeps = {
      aggregator, destination, now: () => now,
      setupSafe: async (_db, chainId, address) => {
        destination.setOwners(chainId, address, [MOCK_OWNER, MOCK_COSIGNER]);
        return { ok: true };
      },
      simulate: async () => ({ ok: true, feeUsd: 0.02 }),
      draftLoan: async () => [],
    };
    setMoveDepsForTests(deps);
    const onBase = deposit(createSafe({
      id: "s", name: "S", address: MOCK_OWNER, ownerCount: 1, threshold: 1, networks: ["ethereum", "base"],
    }), "base", { ETH: 5 });
    const plan = await planCrossNetwork({ aggregator, networks: MOVE_NETWORKS, chainOf }, {
      safe: onBase, safeAddress: safe, need: { cash: 7500, months: 12, targetHf: 1.6, asset: "ETH", network: "base" },
      prices: BASE_PRICES, venues: VENUES, loans: [],
    });
    const move = await draftMove(pg.dbA, { safeId, safeAddress: safe, plan: plan!, now, wallet: MOCK_OWNER, destination });

    // Pause before writing proposal_id, after the sender has executed the proposal insert.
    await pg.observer.unsafe(`
      CREATE FUNCTION pause_move_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(991345);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER pause_move_link BEFORE UPDATE OF proposal_id ON moves
        FOR EACH ROW EXECUTE FUNCTION pause_move_link();
    `);
    const post = vi.spyOn(fake, "proposeTransaction");
    await pg.observer`SELECT pg_advisory_lock(991345)`;
    const send = sendMove(context, move.id, deps).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let reconciled: number;
    let duringLink: { stage: string; stopReason: string | null }[];
    try {
      expect(await waitForPostgresLockWait(pg.observer, pg.appA, 'update "moves"')).toBe(true);
      expect(await getMove(pg.dbB, safeId, move.id)).toMatchObject({ status: "quoted", proposalId: null });
      reconciled = await reconcileAllSending(pg.dbB, world.services);
      duringLink = await pg.dbB.select({ stage: proposals.stage, stopReason: proposals.stopReason }).from(proposals);
    } finally {
      await pg.observer`SELECT pg_advisory_unlock(991345)`;
    }
    const sent = await send;
    expect(duringLink).toEqual([]);
    expect(reconciled).toBe(0);
    expect(sent).toMatchObject({ result: { stage: "queued" } });
    if ("error" in sent) throw sent.error;

    const [proposal] = await pg.dbB.select().from(proposals).where(eq(proposals.id, sent.result.proposalId));
    expect(proposal).toMatchObject({ stage: "queued", stopReason: null });
    expect(await getMove(pg.dbB, safeId, move.id)).toMatchObject({ status: "queued", proposalId: proposal.id });
    expect(await fake.getMultisigTransaction(proposal.safeTxHash as Hex)).not.toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  } finally {
    setMoveDepsForTests(undefined);
    vi.restoreAllMocks();
    world.reset();
    await pg.close();
  }
});
