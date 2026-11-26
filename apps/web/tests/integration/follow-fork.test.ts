// BP-15 on a Base fork: a 2-of-2 test Safe, an open batch proposed into the fake service by the agent
// (delegate), confirmed by the second owner in the fake, executed on the fork with both owner keys.
// The follower sees queued -> 1 of 2 signed -> executed, and the figure in the Done message is the
// lender's own. A reverted execution is reported as failed and changes no loan.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress, parseEther, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { createAccess } from "@/server/auth/access";
import { loadThread } from "@/server/agent/persist";
import { setPublicClientForTests } from "@/server/chain/client";
import { readAavePosition } from "@/server/chain/reads";
import { createViemReader } from "@/server/chain/reader";
import { proposals } from "@/server/db/schema";
import { refreshProposal } from "@/server/proposals/follow";
import { sendLive as sendToSafe } from "@/../tests/helpers/live-send";
import { proposalView } from "@/server/proposals/view";
import { chainTestRunDeps } from "@/server/proposals/test-run";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import type { Services } from "@/server/services";
import type { Address, Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../helpers/world";

const owners = [0, 1].map((i) => privateKeyToAccount(ANVIL_KEYS[i]!).address) as Address[];
const bothKeys = ANVIL_KEYS.slice(0, 2) as unknown as Hex[];

async function startWithRetries(): Promise<Fork> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}

describe("follow a proposal to execution on a Base fork", () => {
  let fork: Fork;
  let w: TestWorld;
  let services: Services;
  let salt = 700;
  beforeAll(async () => {
    fork = await startWithRetries();
    setPublicClientForTests(8453, fork.publicClient as PublicClient);
  });
  afterAll(async () => {
    setPublicClientForTests(8453, undefined);
    await fork?.stop();
  });
  beforeEach(async () => {
    w = await createTestWorld();
    const reader = createViemReader();
    services = { ...w.services, mock: false, reader, access: createAccess({ readOwners: reader.readSafeOwners }), testRunDeps: chainTestRunDeps };
  });
  afterEach(() => w.reset());

  async function queued() {
    const d = await deployTestSafe({ fork, owners, threshold: 2, saltNonce: String(salt++) });
    const safe = getAddress(d.address) as Address;
    await fork.testClient.setBalance({ address: safe, value: parseEther("10") });
    const safeId = await w.trackSafe(safe, { agentAdded: true });
    const fake = w.services.fakes.get(8453)!;
    fake.setOwners(safe, owners, 2);
    const delegation = await privateKeyToAccount(ANVIL_KEYS[1]!).signTypedData(delegateTypedData(8453, services.signer.address));
    await fake.addDelegate({ safe, delegate: services.signer.address, delegator: owners[1]!, label: "Lender agent", signature: delegation });
    const { cookie } = await w.signIn(owners[0]!);
    const ctx = await safeContext(w.req("/", { cookie }), safe, services);
    const sent = await sendToSafe(ctx, { draftKey: "fork", chainId: 8453, cash: 2000, hfIdx: 1 });
    expect(sent.stage).toBe("queued");
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, sent.proposalId));
    return { safe, safeId, fake, row, id: sent.proposalId, hash: row.safeTxHash as Hex };
  }
  const view = async (id: string, safe: Address) => {
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    return proposalView(row, { viewer: owners[0]!, threshold: row.threshold ?? 2, safeAddress: safe });
  };

  it("queued -> 1 of 2 signed -> executed, with the lender's own health", async () => {
    const { safe, safeId, fake, row, id, hash } = await queued();
    await refreshProposal(w.db, services, id);
    expect((await view(id, safe)).sentence).toBe("In your Safe queue. Needs 2 signatures.");

    fake.confirm(hash, owners[1]!);
    await refreshProposal(w.db, services, id);
    expect((await view(id, safe)).sentence).toBe("1 of 2 signed. Needs 1 more signature.");

    const exec = await execSafeTx(fork, safe, row.tx as never, bothKeys);
    expect(exec.success).toBe(true);
    expect(exec.safeTxHash.toLowerCase()).toBe(hash.toLowerCase());
    fake.markExecuted(hash, { success: true, txHash: exec.receipt.transactionHash });
    expect(await refreshProposal(w.db, services, id)).toBe(true);
    await refreshProposal(w.db, services, id);

    const v = await view(id, safe);
    expect(v.stage).toBe("executed");
    expect(v.sentence).toBe("Done. Executed in Safe.");
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(after.executedTxHash).toBe(exec.receipt.transactionHash);
    const done = (await loadThread(w.db, safeId)).filter((m) => m.id === `done-${id}`);
    expect(done).toHaveLength(1);
    const hf = (await readAavePosition(8453, safe)).position!.healthFactor;
    expect(JSON.stringify(done[0].parts)).toContain(`Health factor ${hf.toFixed(2)}.`);
  }, 300_000);

  it("a reverted execution is failed and the lender holds no loan", async () => {
    const { safe, safeId, fake, row, id, hash } = await queued();
    fake.confirm(hash, owners[1]!);
    // The wrap step needs the ETH: drain the Safe so the inner call fails.
    await fork.testClient.setBalance({ address: safe, value: 0n });
    const exec = await execSafeTx(fork, safe, row.tx as never, bothKeys);
    expect(exec.success).toBe(false);
    fake.markExecuted(hash, { success: false, txHash: exec.receipt.transactionHash });
    await refreshProposal(w.db, services, id);
    expect((await view(id, safe)).stage).toBe("failed");
    expect((await readAavePosition(8453, safe)).position).toBeNull();
    expect((await loadThread(w.db, safeId)).filter((m) => m.id.startsWith("done-"))).toHaveLength(0);
  }, 300_000);
});
