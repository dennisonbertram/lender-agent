// BP-16 on a Base fork: a 2-of-2 test Safe, an open batch proposed as the agent into the fake
// service. An unconfirmed proposal is deleted by Reject; a confirmed one is left in the queue and
// the same transaction is still executable with both owners' signatures.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { proposals } from "@/server/db/schema";
import { rejectProposal } from "@/server/proposals/reject";
import { sendLive as sendToSafe } from "@/../tests/helpers/live-send";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import type { Address, Hex, SafeTx } from "@/shared/types";

const keys = [ANVIL_KEYS[0], ANVIL_KEYS[1]] as Hex[];
const owners = keys.map((k) => privateKeyToAccount(k).address) as Address[];

describe("reject on a Base fork (2-of-2 Safe)", () => {
  let fork: Fork;
  let safe: Address;
  let w: TestWorld;
  let ctx: Awaited<ReturnType<typeof safeContext>>;
  const fake = () => w.services.fakes.get(8453)!;

  beforeAll(async () => {
    fork = await startBaseFork();
    const d = await deployTestSafe({ fork, owners, threshold: 2, saltNonce: "7716" });
    safe = d.address;
    await fork.testClient.setBalance({ address: safe, value: parseEther("10") });
  }, 120_000);
  afterAll(async () => { await fork?.stop(); });

  beforeEach(async () => {
    w = await createTestWorld();
    w.services.fixture.setOwners(8453, safe, owners, 2);
    w.services.fixture.setPrices({ ETH: 1912, WETH: 1912 }); // the fork block's Aave oracle price
    w.services.fixture.setBalances(8453, safe, { ETH: 10, wstETH: 0, USDC: 0 });
    fake().setOwners(safe, owners, 2);
    await w.trackSafe(safe, { agentAdded: true });
    const { cookie } = await w.signIn(owners[1]!);
    const sig = await privateKeyToAccount(keys[1]!).signTypedData(delegateTypedData(8453, w.services.signer.address));
    await fake().addDelegate({ safe, delegate: w.services.signer.address, delegator: owners[1]!, label: "Lender agent", signature: sig });
    ctx = await safeContext(w.req("/", { cookie }), safe, w.services);
  });
  afterEach(() => w.reset());

  const propose = async (draftKey: string) => {
    const r = await sendToSafe(ctx, { draftKey, chainId: 8453, cash: 2000, hfIdx: 1 });
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    return row;
  };

  it("(a) unconfirmed: Reject deletes it from the queue", async () => {
    const row = await propose("a");
    expect(await fake().getMultisigTransaction(row.safeTxHash as Hex)).not.toBeNull();
    const v = await rejectProposal(ctx, row.id);
    expect(v).toMatchObject({ stage: "rejected", sentence: "Rejected. Nothing was sent." });
    expect(await fake().getMultisigTransaction(row.safeTxHash as Hex)).toBeNull();
  });

  it("(b) confirmed by one owner: Reject leaves it, and it is still executable with both signatures", async () => {
    const row = await propose("b");
    fake().confirm(row.safeTxHash as Hex, owners[0]!);
    const v = await rejectProposal(ctx, row.id);
    expect(v.sentence).toBe("Rejected here. It is still in your Safe queue. Reject it in Safe too.");
    expect(v.inSafe).toBe(true);
    expect(await fake().getMultisigTransaction(row.safeTxHash as Hex)).not.toBeNull();

    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, row.id));
    const r = await execSafeTx(fork, safe, after.tx as SafeTx, keys);
    expect(r.success).toBe(true);
    expect(r.safeTxHash.toLowerCase()).toBe(row.safeTxHash);
  }, 120_000);
});
