// BP-26 x BP-31: collateral that a close returns to the Safe is not a deposit (a wstETH loan: wstETH is a watched asset; an ETH loan returns WETH, which is not). Runs the real close
// proposal, the mock Safe{Wallet} execution, the proposal follower and the deposit job together.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pollDeposits } from "@/server/deposits/poll";
import { schema } from "@/server/db/client";
import { mockExecute } from "@/server/mock/safe-wallet";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { closeLoan } from "@/server/proposals/close";
import { followOpenProposals } from "@/server/proposals/follow";
import { safeContext } from "@/server/request";
import { delegateTypedData } from "@/server/safe/hash";
import type { Hex, LoanPosition } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../helpers/world";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const WSTETH = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
let w: TestWorld;
let safeId: number;
let ctx: Awaited<ReturnType<typeof safeContext>>;
const T0 = new Date(Date.now() - 3600_000);
const poll = (now = new Date()) => pollDeposits({ db: w.db, reader: w.services.reader, now, log: () => {} });
const deposits = () => w.db.select().from(schema.deposits);

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  await w.db.update(schema.safes).set({ createdAt: new Date("2025-01-01T00:00:00Z") }).where(eq(schema.safes.id, safeId));
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await w.services.fakes.get(8453)!.addDelegate({ safe: SAFE, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
  const position: LoanPosition = {
    chainId: 8453, safe: SAFE, lender: "aave-v3", id: `8453:${SAFE.toLowerCase()}:aave-v3`,
    collateral: [{ asset: "wstETH", token: WSTETH, amount: 2, usd: 6000 }], debt: [{ asset: "USDC", token: USDC, amount: 2000, usd: 2000 }],
    healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n,
  };
  w.services.fixture.setPosition(8453, SAFE, position);
  w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 2500 });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
  await poll(T0); // the silent baseline
});
afterEach(() => w.reset());

async function queueClose() {
  const r = await closeLoan(ctx, { loanId: `8453:${SAFE.toLowerCase()}:aave-v3` });
  const [row] = await w.db.select().from(schema.proposals).where(eq(schema.proposals.id, r.proposalId));
  return { id: r.proposalId, hash: row!.safeTxHash as Hex };
}

describe("a close's returned collateral is not a deposit", () => {
  it("executed and followed before the poll: no deposit, no Activity row, no chat message", async () => {
    const c = await queueClose();
    await mockExecute(w.services, 8453, c.hash);
    await followOpenProposals(w.db, w.services);
    expect((await w.db.select().from(schema.proposals).where(eq(schema.proposals.id, c.id)))[0]!.stage).toBe("executed");
    await poll();
    expect(await deposits()).toHaveLength(0);
    expect((await w.db.select().from(schema.activity).where(eq(schema.activity.safeId, safeId))).filter((a) => /deposit/i.test(a.text))).toHaveLength(0);
  });

  it("the poll runs before the follower has marked it executed: still no deposit (the Safe nonce says it ran)", async () => {
    const c = await queueClose();
    await mockExecute(w.services, 8453, c.hash); // chain moved; our row is still "queued"
    expect((await w.db.select().from(schema.proposals).where(eq(schema.proposals.id, c.id)))[0]!.stage).toBe("queued");
    await poll();
    expect(await deposits()).toHaveLength(0);
    await followOpenProposals(w.db, w.services);
    await poll();
    expect(await deposits()).toHaveLength(0);
  });

  it("a real deposit while a close is still waiting in the queue is announced", async () => {
    await queueClose();
    w.services.fixture.setBalances(8453, SAFE, { ETH: 3.1, USDC: 2500 });
    await poll();
    const deps = await deposits();
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ asset: "ETH", amount: "3" });
  });
});
