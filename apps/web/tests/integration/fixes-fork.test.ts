// BP-22 and BP-23 on a Base fork: a 2-of-2 Safe holds a real Aave loan at about 1.04 (At risk). Each fix option
// (add collateral, repay, half of each) is drafted from the lender's own figures, proposed by the agent into the
// fake Transaction Service, executed with both owner keys, and the lender's own health ends above the At-risk
// level. Two fixes at the Safe's current nonce are both pending; once one executes the other cannot (D-10).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress, parseEther, parseUnits, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { setUsdc } from "../helpers/oracle";
import { deployTestSafe, execSafeTx } from "../helpers/safe";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import { createAccess } from "@/server/auth/access";
import { erc20Abi, poolAbi, wethAbi } from "@/server/chain/abis";
import { setPublicClientForTests } from "@/server/chain/client";
import { AAVE, tokenBySymbol } from "@/server/chain/config";
import { readAavePosition } from "@/server/chain/reads";
import { createViemReader } from "@/server/chain/reader";
import { proposals } from "@/server/db/schema";
import { draftFix, fixOptionsFor, fixStateFor, sendFix, type FixOptionKey } from "@/server/fixes";
import { chainTestRunDeps } from "@/server/proposals/test-run";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import type { Services } from "@/server/services";
import type { Address, Hex, SafeTx } from "@/shared/types";

const owners = [0, 1].map((i) => privateKeyToAccount(ANVIL_KEYS[i]!).address) as Address[];
const bothKeys = ANVIL_KEYS.slice(0, 2) as unknown as Hex[];
const aave = AAVE[8453]!;
const WETH = tokenBySymbol(8453, "WETH")!.address!;
const USDC = tokenBySymbol(8453, "USDC")!.address!;

async function startWithRetries(): Promise<Fork> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await startBaseFork(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}

describe("fix options and urgent fixes on a Base fork", () => {
  let fork: Fork;
  let w: TestWorld;
  let services: Services;
  let safe: Address;
  let safeId: number;
  let loanId: string;
  let snapshotId: Hex;
  let salt = 900;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function asSafe(req: any) {
    const hash = await fork.walletClient.writeContract({ account: safe, chain: fork.chain, gas: 2_000_000n, ...req });
    const receipt = await fork.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`tx reverted: ${req.functionName}`);
  }

  beforeAll(async () => {
    fork = await startWithRetries();
    setPublicClientForTests(8453, fork.publicClient as PublicClient);
    const d = await deployTestSafe({ fork, owners, threshold: 2, saltNonce: String(salt++) });
    safe = getAddress(d.address) as Address;
    await fork.testClient.setBalance({ address: safe, value: parseEther("20") });
    await fork.testClient.impersonateAccount({ address: safe });
    await asSafe({ address: WETH, abi: wethAbi, functionName: "deposit", value: parseEther("3") });
    await asSafe({ address: WETH, abi: erc20Abi, functionName: "approve", args: [aave.pool, parseEther("3")] });
    await asSafe({ address: aave.pool, abi: poolAbi, functionName: "supply", args: [WETH, parseEther("3"), safe, 0] });
    // Borrow to about 97% of the borrowing power: health about 1.07, well under the At-risk level 1.35.
    const data = await fork.publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [safe] });
    const borrowUsd = (Number(data[2]) / 1e8) * 0.97; // availableBorrowsBase, 8 decimals
    await asSafe({ address: aave.pool, abi: poolAbi, functionName: "borrow", args: [USDC, parseUnits(String(Math.floor(borrowUsd)), 6), 2n, 0, safe] });
    await fork.testClient.setBalance({ address: safe, value: parseEther("15") });
    await setUsdc(fork, safe, parseUnits("0", 6)); // the borrowed USDC is not on hand: repay is greyed until a test funds it
    loanId = `8453:${safe.toLowerCase()}:aave-v3`;
  }, 300_000);
  afterAll(async () => {
    setPublicClientForTests(8453, undefined);
    await fork?.stop();
  });
  beforeEach(async () => {
    snapshotId = (await fork.testClient.snapshot()) as unknown as Hex;
    w = await createTestWorld();
    const reader = createViemReader();
    services = { ...w.services, mock: false, reader, access: createAccess({ readOwners: reader.readSafeOwners }), testRunDeps: chainTestRunDeps };
    safeId = await w.trackSafe(safe, { agentAdded: true });
    const fake = w.services.fakes.get(8453)!;
    fake.setOwners(safe, owners, 2);
    const delegation = await privateKeyToAccount(ANVIL_KEYS[1]!).signTypedData(delegateTypedData(8453, services.signer.address));
    await fake.addDelegate({ safe, delegate: services.signer.address, delegator: owners[1]!, label: "Lender agent", signature: delegation });
  });
  afterEach(async () => {
    w.reset();
    await fork.testClient.revert({ id: snapshotId });
  });

  const ctxOf = async () => safeContext(w.req("/", { cookie: (await w.signIn(owners[0]!)).cookie }), safe, services);
  const hf = async () => (await readAavePosition(8453, safe)).position!.healthFactor;

  it("starts At risk, and a greyed option says what the Safe lacks", async () => {
    expect(await hf()).toBeLessThan(DEFAULT_LEVELS.act);
    const r = (await fixOptionsFor({ id: safeId, address: safe }, { id: loanId, chainId: 8453 }, { db: w.db, services }))!;
    expect(r.atRisk).toBe(true);
    expect(r.urgent).toBe(true);
    expect(r.options.find((o) => o.k === "repay")!.sub).toMatch(/^Needs [\d,]+ USDC\. Your Safe has 0 USDC\.$/);
    expect(r.options.find((o) => o.k === "coll")!.short).toBe(false);
  });

  const options: FixOptionKey[] = ["coll", "repay", "both"];
  for (const option of options) {
    it(`"${option}": the drafted fix, executed, raises the lender's health above the At-risk level`, async () => {
      await setUsdc(fork, safe, parseUnits("40000", 6));
      const ctx = await ctxOf();
      const before = await hf();
      const draft = await draftFix(ctx, { loanId, option });
      expect(draft.canSend).toBe(true);
      expect(draft.healthBefore).toBeCloseTo(before, 4);
      expect(draft.healthAfter!).toBeGreaterThan(DEFAULT_LEVELS.act);
      const sent = await sendFix(ctx, draft.id);
      expect(sent.stage).toBe("queued");
      const [row] = await w.db.select().from(proposals).where(eq(proposals.id, sent.proposalId));
      expect(row.nonce).toBe(0n); // the Safe's current nonce
      const exec = await execSafeTx(fork, safe, row.tx as SafeTx, bothKeys);
      expect(exec.success).toBe(true);
      const after = await hf();
      expect(after).toBeGreaterThan(DEFAULT_LEVELS.act);
      expect(after).toBeCloseTo(draft.healthAfter!, 3); // the test run's figure is the lender's figure
    }, 120_000);
  }

  it("two fixes at one nonce are both pending; after one executes the other can no longer run (D-10)", async () => {
    await setUsdc(fork, safe, parseUnits("40000", 6));
    const ctx = await ctxOf();
    const a = await sendFix(ctx, (await draftFix(ctx, { loanId, option: "coll" })).id);
    const b = await sendFix(ctx, (await draftFix(ctx, { loanId, option: "repay" })).id);
    const [ra] = await w.db.select().from(proposals).where(eq(proposals.id, a.proposalId));
    const [rb] = await w.db.select().from(proposals).where(eq(proposals.id, b.proposalId));
    expect([ra.nonce, rb.nonce]).toEqual([0n, 0n]);
    expect(ra.safeTxHash).not.toBe(rb.safeTxHash);
    const fake = w.services.fakes.get(8453)!;
    expect((await fake.getMultisigTransaction(ra.safeTxHash as Hex))?.isExecuted).toBe(false);
    expect((await fake.getMultisigTransaction(rb.safeTxHash as Hex))?.isExecuted).toBe(false);
    expect(await fixStateFor(w.db, safeId, loanId)).toMatchObject({ fix: "queued" });

    expect((await execSafeTx(fork, safe, rb.tx as SafeTx, bothKeys)).success).toBe(true);
    expect((await execSafeTx(fork, safe, ra.tx as SafeTx, bothKeys)).success).toBe(false); // nonce 0 is used
  }, 180_000);
});
