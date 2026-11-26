import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadThread } from "@/server/agent/persist";
import { stopAgentProposals } from "@/server/agent-role";
import { activity, proposals } from "@/server/db/schema";
import { mockExecute } from "@/server/mock/safe-wallet";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import { loansFor } from "@/server/loans";
import type { Hex } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import { followOpenProposals, NONCE_PASSED_GRACE_MS, refreshProposal } from "./follow";
import { getProposal } from "./read";
import { nextNonce } from "./send";
import { sendLive as sendToSafe } from "@/../tests/helpers/live-send";

import { COMET_USDC_BASE, MORPHO_WETH_USDC_ID } from "@/server/lenders/allowlist";
import type { FixtureLenders } from "@/server/lenders/fixture";

const COMPOUND = { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" } as const;
const MORPHO = { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC_ID, collateral: "WETH" } as const;
const SAFE = getAddress(MOCK_SAFE.toLowerCase());
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;
const fake = () => w.services.fakes.get(8453)!;

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: sig });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => w.reset());

async function queue() {
  const r = await sendToSafe(ctx, { draftKey: `k${Math.random()}`, chainId: 8453, cash: 2000, hfIdx: 1 });
  const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
  return { id: r.proposalId, hash: row.safeTxHash as Hex };
}
const stage = async (id: string) => (await getProposal(ctx, id).catch(() => null))?.stage;
const sentence = async (id: string) => {
  const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
  return (await import("./view")).proposalView(row, { viewer: MOCK_OWNER, threshold: row.threshold ?? 2, safeAddress: SAFE }).sentence;
};
const acts = () => w.db.select().from(activity).where(eq(activity.safeId, safeId));
const doneMessages = async () => (await loadThread(w.db, safeId)).filter((m) => m.id.startsWith("done-"));

describe("refreshProposal", () => {
  it("moves the card from queued to 1 of 2 signed, with the co-signer's own address in Activity", async () => {
    const { id, hash } = await queue();
    expect(await sentence(id)).toBe("In your Safe queue. Needs 2 signatures.");
    fake().confirm(hash, MOCK_COSIGNER);
    await refreshProposal(w.db, w.services, id);
    expect(await sentence(id)).toBe("1 of 2 signed. Needs 1 more signature.");
    await refreshProposal(w.db, w.services, id);
    const signed = (await acts()).filter((a) => a.kind === "signed");
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({ actor: "Co-signer", actorAddress: MOCK_COSIGNER.toLowerCase() });
  });

  it("executed: one Done message however often it runs, and the loan shows", async () => {
    const { id, hash } = await queue();
    fake().confirm(hash, MOCK_COSIGNER);
    await mockExecute(w.services, 8453, hash);
    expect(await refreshProposal(w.db, w.services, id)).toBe(true);
    expect(await refreshProposal(w.db, w.services, id)).toBe(false);
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row.stage).toBe("executed");
    expect(row.executedTxHash).toBeTruthy();
    const done = await doneMessages();
    expect(done).toHaveLength(1);
    expect(done[0].id).toBe(`done-${id}`);
    expect(JSON.stringify(done[0].parts)).toMatch(/Done\. Your \$2,000 Aave v3 loan is open\..*Health factor \d\.\d\d\./);
    expect((await acts()).filter((a) => a.kind === "status" && a.text.startsWith("Executed"))).toHaveLength(1);
    expect((await loansFor(ctx)).loans.length).toBeGreaterThan(0);
  });

  it("executed: the activity row carries the execution tx hash and the Safe tx hash", async () => {
    const { id, hash } = await queue();
    fake().confirm(hash, MOCK_COSIGNER);
    await mockExecute(w.services, 8453, hash);
    await refreshProposal(w.db, w.services, id);
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    const exec = (await acts()).find((a) => a.text.startsWith("Executed"))!;
    expect(exec.txHash).toBe(row.executedTxHash!.toLowerCase());
    expect(exec.safeTxHash).toBe(hash.toLowerCase());
  });

  it.each([["compound-v3", "Compound v3", COMPOUND], ["morpho-blue", "Morpho", MORPHO]] as const)("executed %s loan: the Done line names that lender and its own health", async (venueId, name, ref) => {
    const r = await sendToSafe(ctx, { draftKey: `k${Math.random()}`, chainId: 8453, cash: 2000, hfIdx: 1, venueId });
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    await mockExecute(w.services, 8453, row.safeTxHash as Hex);
    expect(await refreshProposal(w.db, w.services, r.proposalId)).toBe(true);
    const done = JSON.stringify((await doneMessages())[0].parts);
    expect(done).toContain(`Done. Your $2,000 ${name} loan is open.`);
    expect(done).not.toContain("Aave");
    const stored = await (w.services.lenders as FixtureLenders).position(ref, SAFE);
    expect(done).toMatch(/Health factor \d\.\d\d\./);
    expect(done).toContain(`Health factor ${stored!.health!.toFixed(2)}.`);
  });

  it("reverted: failed, an Activity row, no loan change, no Done message", async () => {
    const before = (await loansFor(ctx)).loans.length;
    const { id, hash } = await queue();
    await mockExecute(w.services, 8453, hash, { revert: true });
    await refreshProposal(w.db, w.services, id);
    await refreshProposal(w.db, w.services, id);
    expect(await stage(id)).toBe("failed");
    expect((await acts()).filter((a) => a.text.startsWith("Failed"))).toHaveLength(1);
    expect(await doneMessages()).toHaveLength(0);
    expect((await loansFor(ctx)).loans.length).toBe(before);
  });

  it("threshold 1: queued straight to executed, no co-signer stage", async () => {
    w.services.fixture.setOwners(8453, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 1);
    fake().setOwners(SAFE, [MOCK_OWNER, MOCK_COSIGNER], 1);
    const { id, hash } = await queue();
    expect(await sentence(id)).toBe("In your Safe queue. Needs 1 signature.");
    await mockExecute(w.services, 8453, hash);
    await refreshProposal(w.db, w.services, id);
    expect(await sentence(id)).toBe("Done. Executed in Safe.");
  });
});

describe("followOpenProposals", () => {
  it("refreshes every queued proposal; one failing proposal does not stop the rest", async () => {
    const a = await queue();
    const b = await queue();
    await w.db.update(proposals).set({ safeTxHash: "0x" + "ab".repeat(32) }).where(eq(proposals.id, a.id)); // unknown to the service
    fake().confirm(b.hash, MOCK_COSIGNER);
    await followOpenProposals(w.db, w.services);
    const [rb] = await w.db.select().from(proposals).where(eq(proposals.id, b.id));
    expect(rb.confirmations).toHaveLength(1);
  });
});

describe("closed proposals that are still in Safe", () => {
  it.each(["rejected", "stale", "stopped"] as const)("a %s one that is executed anyway is recorded as executed", async (stageName) => {
    const { id, hash } = await queue();
    await w.db.update(proposals).set({ stage: stageName }).where(eq(proposals.id, id));
    await mockExecute(w.services, 8453, hash);
    await followOpenProposals(w.db, w.services);
    expect(await stage(id)).toBe("executed");
    expect((await acts()).some((a) => a.text.startsWith("Executed in Safe"))).toBe(true);
    expect(await sentence(id)).toBe("Done. Executed in Safe.");
  });

  it("a lagging service: nonce past theirs but not yet shown executed keeps following, and records the execution once it shows", async () => {
    const { id, hash } = await queue();
    await w.db.update(proposals).set({ stage: "rejected" }).where(eq(proposals.id, id));
    w.services.fixture.setNonce(8453, SAFE, 5n);
    await followOpenProposals(w.db, w.services);
    let [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row.stage).toBe("rejected");
    expect(row.deletedFromQueue).toBe(false);
    await followOpenProposals(w.db, w.services);
    [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row.deletedFromQueue).toBe(false);
    fake().markExecuted(hash, { success: true, txHash: ("0x" + "cd".repeat(32)) as Hex });
    await followOpenProposals(w.db, w.services);
    expect(await stage(id)).toBe("executed");
  });

  it("stops following once the grace period after the nonce passed is over", async () => {
    const { id } = await queue();
    await w.db.update(proposals).set({ stage: "rejected" }).where(eq(proposals.id, id));
    w.services.fixture.setNonce(8453, SAFE, 5n);
    await followOpenProposals(w.db, w.services);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + NONCE_PASSED_GRACE_MS + 60_000);
      await followOpenProposals(w.db, w.services);
    } finally {
      vi.useRealTimers();
    }
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row.stage).toBe("rejected");
    expect(row.deletedFromQueue).toBe(true);
  });

  it("a transaction absent from the service while its nonce is unused was deleted: final", async () => {
    const { id } = await queue();
    await w.db.update(proposals).set({ stage: "stopped" }).where(eq(proposals.id, id));
    vi.spyOn(fake(), "getMultisigTransaction").mockResolvedValue(null);
    await followOpenProposals(w.db, w.services);
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row.deletedFromQueue).toBe(true);
    const { proposalView } = await import("./view");
    const v = proposalView(row, { viewer: MOCK_OWNER, threshold: 2, safeAddress: SAFE });
    expect(v.final).toBe(true);
    expect(v.sentence).not.toMatch(/still in your Safe queue/);
  });

  it("keeps the nonce reserved when agent removal cannot confirm deletion", async () => {
    const { id } = await queue();
    vi.spyOn(fake(), "getMultisigTransaction").mockResolvedValue(null);
    await stopAgentProposals(w.db, w.services, safeId);
    const [stopped] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(stopped).toMatchObject({ stage: "stopped", deletedFromQueue: false, nonce: 0n });

    await followOpenProposals(w.db, w.services);

    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
    const [followed] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    expect(followed.deletedFromQueue).toBe(false);
  });

  it("the view is not final while it can still execute", async () => {
    const { id } = await queue();
    await w.db.update(proposals).set({ stage: "stopped" }).where(eq(proposals.id, id));
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, id));
    const { proposalView } = await import("./view");
    expect(proposalView(row, { viewer: MOCK_OWNER, threshold: 2, safeAddress: SAFE }).final).toBe(false);
  });
});
