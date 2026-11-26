// BP-33/34 on a Base fork: a Compound v3 plan and a Morpho plan each pass the Test run and queue through
// Send (the adapter's own builders and the invariants), execute on the fork, and the dashboard then shows the
// figures the plan card quoted, from the lender's own numbers (VC-02, M4 exit 2).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress, parseEther, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { sendLive as sendToSafe } from "../helpers/live-send";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { createAccess } from "@/server/auth/access";
import { setPublicClientForTests } from "@/server/chain/client";
import { createViemReader } from "@/server/chain/reader";
import { proposals } from "@/server/db/schema";
import { compareFor } from "@/server/blocks/compare";
import { adapterFor, MORPHO_WETH_USDC_ID, COMET_USDC_BASE } from "@/server/lenders";
import { chainLenderReads } from "@/server/lenders/reads";
import { loansFor } from "@/server/loans";
import { chainTestRunDeps } from "@/server/proposals/test-run";
import { quotePlan } from "@/server/quote";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import type { Services } from "@/server/services";
import type { Address, Hex } from "@/shared/types";

const owner = privateKeyToAccount(ANVIL_KEYS[0]!).address as Address;
const keys: Hex[] = [ANVIL_KEYS[0] as Hex];

async function startWithRetries(): Promise<Fork> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}

describe("Compound and Morpho plans on a Base fork", () => {
  let fork: Fork;
  let w: TestWorld;
  let services: Services;
  let salt = 900;
  beforeAll(async () => {
    fork = await startWithRetries();
    setPublicClientForTests(8453, fork.publicClient as PublicClient);
  }, 240_000);
  afterAll(async () => {
    setPublicClientForTests(8453, undefined);
    await fork?.stop();
  });
  beforeEach(async () => {
    w = await createTestWorld();
    const reader = createViemReader();
    services = { ...w.services, mock: false, reader, access: createAccess({ readOwners: reader.readSafeOwners }), testRunDeps: chainTestRunDeps, lenders: chainLenderReads };
  });
  afterEach(() => w.reset());

  it.each([
    ["compound-v3", "Compound v3", COMET_USDC_BASE],
    ["morpho-blue", "Morpho", MORPHO_WETH_USDC_ID],
  ] as const)("%s: passes the Test run, queues, executes, and the dashboard shows the plan's figures", async (venueId, name, marketId) => {
    const d = await deployTestSafe({ fork, owners: [owner], threshold: 1, saltNonce: String(salt++) });
    const safe = getAddress(d.address) as Address;
    await fork.testClient.setBalance({ address: safe, value: parseEther("10") });
    const safeId = await w.trackSafe(safe, { agentAdded: true });
    const fake = w.services.fakes.get(8453)!;
    fake.setOwners(safe, [owner], 1);
    await fake.addDelegate({ safe, delegate: services.signer.address, delegator: owner, label: "Lender agent", signature: await privateKeyToAccount(ANVIL_KEYS[0]!).signTypedData(delegateTypedData(8453, services.signer.address)) });
    const { cookie } = await w.signIn(owner);
    const ctx = await safeContext(w.req("/", { cookie }), safe, services);

    // The plan card: the lender's own rate and thresholds, and a Test run that passes.
    const q = await quotePlan({ db: w.db, services, safe: { id: safeId, address: safe.toLowerCase() } }, { cash: 5000, venueId, asset: "ETH", messageId: "m1" });
    expect(q.status).toBe("ok");
    if (q.quote.kind !== "ok") throw new Error("expected ok");
    expect(q.quote.lender).toBe(name);
    expect(q.testRun).toMatchObject({ canSend: true });
    expect(q.testRun.line).toMatch(/^Checked: this would work/);

    // The compare block shows the same figures from the same block's lender reads.
    const cmp = await compareFor(ctx, { cash: 5000, asset: "ETH" });
    expect(cmp.rows.find((r) => r.venueId === venueId)).toMatchObject({ feasible: true, apr: q.quote.apr, yearly: q.quote.yearly, dropPct: q.quote.dropPct, liqPrice: q.quote.liqPrice });

    // Queue it through Send, then execute the stored transaction.
    const sent = await sendToSafe(ctx, { draftKey: `fork-${venueId}`, chainId: 8453, cash: 5000, venueId, asset: "ETH", hfIdx: 1 });
    expect(sent.stage).toBe("queued");
    const [row] = await w.db.select().from(proposals).where(eq(proposals.id, sent.proposalId));
    expect((row.spec as { venueId: string }).venueId).toBe(venueId);
    const exec = await execSafeTx(fork, safe, row.tx as never, keys);
    expect(exec.success).toBe(true);

    // The lender's own position matches the plan, and the dashboard prints the plan card's figures.
    const ref = { lender: venueId, chainId: 8453 as const, marketId, collateral: "WETH" as const };
    const pos = (await adapterFor(venueId).readPosition(ref, safe))!;
    expect(pos.debt[0]!.amount).toBeCloseTo(5000, 1);
    const quotedHealth = q.quote.price / q.quote.liqPrice;
    expect(Math.abs(pos.health! - quotedHealth) / pos.health!).toBeLessThan(0.005);
    const { loans } = await loansFor(ctx);
    const loan = loans.find((l) => l.lender === name)!;
    expect(loan).toBeTruthy();
    expect(loan.apr).toBe(q.quote.apr);
    expect(Math.abs(loan.liquidationPrice! - q.quote.liqPrice) / q.quote.liqPrice).toBeLessThan(0.005);
    expect(loan.canFallPct).toContain(`${q.quote.dropPct}%`);
  }, 300_000);
});
