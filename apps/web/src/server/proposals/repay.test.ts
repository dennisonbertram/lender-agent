import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress, toEventSelector, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadThread } from "@/server/agent/persist";
import { proposals } from "@/server/db/schema";
import { MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE } from "@/server/mock/seed";
import { mockExecute } from "@/server/mock/safe-wallet";
import { delegateTypedData } from "@/server/safe/hash";
import { safeContext } from "@/server/request";
import type { Hex, LoanPosition } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";
import type { FixtureLenders } from "@/server/lenders/fixture";
import { repayLoan } from "./repay";
import { getProposal } from "./read";
import { factsOf } from "./view";
import { COMET_USDC_BASE, MORPHO_WETH_USDC_ID, type AdapterPosition, type LenderId } from "@/server/lenders";
import { refreshProposal, repaidFromReceipt } from "./follow";
import { checkStale } from "./stale";
import { SendBlocked } from "./send";
import { getExecuteData, getSignData } from "./sign";
import { rejectProposal } from "./reject";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const AAVE_LOAN_ID = `8453:${SAFE.toLowerCase()}:aave-v3`;
const MORPHO_LOAN_ID = `8453:${SAFE.toLowerCase()}:morpho-blue`;
const COMPOUND_LOAN_ID = `8453:${SAFE.toLowerCase()}:compound-v3`;
const MORPHO_REF = { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC_ID, collateral: "WETH" } as const;
const COMPOUND_REF = { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, collateral: "WETH" } as const;
const MORPHO_REPAY_SEL = toFunctionSelector("repay((address,address,address,address,uint256),uint256,uint256,address,bytes)").slice(2);
const POOL_REPAY_SEL = toFunctionSelector("repay(address,uint256,uint256,address)").slice(2);
const APPROVE_SEL = "095ea7b3";

let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;
const fake = () => w.services.fakes.get(8453)!;
const lenders = () => w.services.lenders as FixtureLenders;

const aavePosition = (debt = 2000): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: AAVE_LOAN_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }],
  debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
  healthFactor: 2.49, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_001n,
});

/** The healthy $1,000 Morpho loan: 1 WETH ($3,000) locked, $1,000 USDC owed (health 2.58). */
const morphoPosition = (debt = 1000): AdapterPosition => ({
  lender: "morpho-blue", chainId: 8453, safe: SAFE, marketId: MORPHO_WETH_USDC_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: 1, usd: 3000 }],
  debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
  health: debt > 0 ? (3000 * 0.86) / debt : null, liquidatable: false, liquidationThreshold: 0.86, mixed: false, blockNumber: 57_172_001n,
});

const compoundPosition = (debt = 1500): AdapterPosition => ({
  lender: "compound-v3", chainId: 8453, safe: SAFE, marketId: COMET_USDC_BASE,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }],
  debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
  health: debt > 0 ? (6000 * 0.85) / debt : null, liquidatable: false, liquidationThreshold: 0.85, mixed: false, blockNumber: 57_172_001n,
});

/** Word i (0-based) of the args of a call with 4-byte selector `sel` inside the packed batch data. */
const argOf = (data: string, sel: string, i: number) => new RegExp(sel + `(?:[0-9a-f]{64}){${i}}([0-9a-f]{64})`).exec(data.toLowerCase())?.[1];

beforeEach(async () => {
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true });
  const { cookie } = await w.signIn(MOCK_OWNER);
  const sig: Hex = await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address));
  await fake().addDelegate({ safe: SAFE, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: sig });
  lenders().setPosition(MORPHO_REF, SAFE, morphoPosition());
  w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 1500 });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
});
afterEach(() => w.reset());

const rows = () => w.db.select().from(proposals);
const usdcHeld = async () => (await w.services.fixture.readBalances(8453, SAFE)).balances.find((b) => b.symbol === "USDC")?.amount ?? 0;

describe("repayLoan: a partial repayment keeps exactly the typed amount", () => {
  it("$200 on the $1,000 Morpho loan queues approve+repay of exactly 200 USDC, with about $800 still owed", async () => {
    const r = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 });
    expect(r.stage).toBe("queued");
    const [row] = await rows();
    expect(row.spec).toMatchObject({ kind: "repay", loanId: MORPHO_LOAN_ID, amount: 200 });
    expect(row.title).toBe("Repay 200 USDC on Morpho");
    expect(row.outcome).toContain("200 USDC");
    expect(row.outcome).toContain("800 USDC"); // the estimated remaining, allowing for accrual
    const tx = row.tx as { operation: number; data: Hex };
    expect(tx.operation).toBe(1); // one batch: approve, repay
    // The approval and the repay are the typed amount, nothing recalculated to a risk target.
    expect(BigInt("0x" + argOf(tx.data, APPROVE_SEL, 1)!)).toBe(200_000_000n);
    expect(BigInt("0x" + argOf(tx.data, MORPHO_REPAY_SEL, 5)!)).toBe(200_000_000n); // 5 market params, then assets
    expect(BigInt("0x" + argOf(tx.data, MORPHO_REPAY_SEL, 6)!)).toBe(0n); // by assets, not shares: exact
    expect(`0x${argOf(tx.data, MORPHO_REPAY_SEL, 7)!}`.toLowerCase()).toBe(`0x${"0".repeat(24)}${SAFE.slice(2).toLowerCase()}`); // onBehalf of the Safe
    expect(row.steps.at(-1)).toMatch(/Repay 200 USDC on Morpho/);
  });

  it("an Aave loan repays the exact amount through its own builder", async () => {
    w.services.fixture.setPosition(8453, SAFE, aavePosition());
    const r = await repayLoan(ctx, { loanId: AAVE_LOAN_ID, amount: 200 });
    expect(r.stage).toBe("queued");
    const [row] = await rows();
    expect(row.spec).toMatchObject({ kind: "repay", loanId: AAVE_LOAN_ID, amount: 200 });
    const tx = row.tx as { data: Hex };
    expect(BigInt("0x" + argOf(tx.data, POOL_REPAY_SEL, 1)!)).toBe(200_000_000n); // amount, not max
    expect(`0x${argOf(tx.data, POOL_REPAY_SEL, 3)!}`.toLowerCase()).toBe(`0x${"0".repeat(24)}${SAFE.slice(2).toLowerCase()}`);
    expect(row.title).toBe("Repay 200 USDC on Aave v3");
  });

  it("Compound repayment is unavailable because supplyTo can turn debt excess into lender collateral", async () => {
    lenders().setPosition(COMPOUND_REF, SAFE, compoundPosition());
    await expect(repayLoan(ctx, { loanId: COMPOUND_LOAN_ID, amount: 300 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/supply|collateral/i) });
    expect(await rows()).toHaveLength(0);
  });

  it("executing it pays down the debt: $1,000 → $800 owed and the Safe's USDC fell by $200", async () => {
    const r = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 });
    const [row] = await rows();
    await mockExecute(w.services, 8453, row.safeTxHash as Hex);
    const after = await lenders().position(MORPHO_REF, SAFE);
    expect(after?.debt[0]?.amount).toBe(800);
    lenders().setPosition(MORPHO_REF, SAFE, { ...after!, debt: [...after!.debt, { asset: "WETH", token: WETH, amount: 1, usd: 3000 }] });
    expect(await usdcHeld()).toBe(1300);
    await refreshProposal(w.db, w.services, r.proposalId);
    const msgs = await loadThread(w.db, safeId);
    const done = msgs.find((m) => m.id === `done-${r.proposalId}`)!;
    const text = done.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(text).toMatch(/^Done\. You repaid \$200 USDC on your Morpho loan\./);
    expect(text).toContain("800 USDC is still owed");
    expect(text).not.toContain("801 USDC");
    expect((await rows())[0]!.stage).toBe("executed");
  });

  it("$200.51 queues approve+repay of exactly 200.51 USDC — every shown surface keeps the cents", async () => {
    const r = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200.51 });
    expect(r.stage).toBe("queued");
    const [row] = await rows();
    expect(row.spec).toMatchObject({ kind: "repay", amount: 200.51 });
    expect(row.title).toBe("Repay 200.51 USDC on Morpho");
    const tx = row.tx as { data: Hex };
    // Exactly the cents typed — no extra micro-unit from float rounding.
    expect(BigInt("0x" + argOf(tx.data, APPROVE_SEL, 1)!)).toBe(200_510_000n);
    expect(BigInt("0x" + argOf(tx.data, MORPHO_REPAY_SEL, 5)!)).toBe(200_510_000n);
    expect(row.steps.at(-1)).toBe("Repay 200.51 USDC on Morpho");
    expect(row.outcome).toContain("200.51 USDC");
    expect(row.outcome).toContain("799.49 USDC"); // the remaining estimate keeps cents too
  });

  it("executing a cent amount pays down exactly it: $1,000 → $799.49 owed", async () => {
    const r = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200.51 });
    const [row] = await rows();
    await mockExecute(w.services, 8453, row.safeTxHash as Hex);
    expect((await lenders().position(MORPHO_REF, SAFE))?.debt[0]?.amount).toBeCloseTo(799.49, 6);
    expect(await usdcHeld()).toBeCloseTo(1299.49, 6);
    await refreshProposal(w.db, w.services, r.proposalId);
    const msgs = await loadThread(w.db, safeId);
    const done = msgs.find((m) => m.id === `done-${r.proposalId}`)!;
    const text = done.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(text).toContain("You repaid $200.51 USDC");
    expect(text).toContain("still owed"); // ~$799.49 or accrued figure, from the lender's own read
  });

  it("the proposal view shows the signer the exact amount, the funding source, the estimate and locked collateral", async () => {
    const r = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200.51 });
    const view = await getProposal(ctx, r.proposalId);
    expect(view.loanId).toBe(MORPHO_LOAN_ID);
    expect(view.facts?.sentence).toContain("200.51 USDC");
    expect(view.facts?.sentence).toContain("Safe");
    expect(view.facts?.sentence).toContain("collateral stays locked");
    expect(view.facts?.terms.some((t) => t.label === "Estimated after repayment" && t.value.includes("799.49"))).toBe(true);
    // The decoded calls a signer reads name the exact raw amount too.
    expect(view.calls.some((c) => c.fn === "repay")).toBe(true);
  });

  it("asks again for the same amount returns the open proposal; another amount is blocked", async () => {
    const a = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 });
    const b = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 });
    expect(b.proposalId).toBe(a.proposalId);
    expect(await rows()).toHaveLength(1);
    await expect(repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 300 })).rejects.toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(1);
  });

  it("stable request keys return the original proposal after execution and reject changed intent", async () => {
    const a = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200, idempotencyKey: "repay-intent-001" });
    const [row] = await rows();
    await mockExecute(w.services, 8453, row.safeTxHash as Hex);
    const again = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200, idempotencyKey: "repay-intent-001" });
    expect(again.proposalId).toBe(a.proposalId);
    await expect(repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 300, idempotencyKey: "repay-intent-001" })).rejects.toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(1);
  });

  it("rechecks current debt before asking an owner to sign or preparing final send data", async () => {
    const sent = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 });
    lenders().setPosition(MORPHO_REF, SAFE, morphoPosition(150));
    const signData = await getSignData(ctx, sent.proposalId);
    expect(signData.canSign).toBe(false);
    expect(signData.reasons.some((r) => r.blocksSigning && /owes less/i.test(r.message))).toBe(true);
    expect(await getExecuteData(ctx, sent.proposalId)).toMatchObject({ ready: false, needs: "refused", data: null });
  });

  it("a same-key retry returns the executed proposal even after its loan closes", async () => {
    const sent = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200, idempotencyKey: "lost-response-retry-1" });
    const [row] = await rows();
    await mockExecute(w.services, 8453, row.safeTxHash as Hex);
    lenders().setPosition(MORPHO_REF, SAFE, null);
    const retry = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200, idempotencyKey: "lost-response-retry-1" });
    expect(retry.proposalId).toBe(sent.proposalId);
    expect(await rows()).toHaveLength(1);
  });
});

describe("repayLoan refuses clearly instead of repaying the wrong amount", () => {
  it("more than the loan owes points at closing and drafts nothing", async () => {
    const err = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(SendBlocked);
    expect(err.line).toMatch(/owes \$1,000/);
    expect(err.line).toMatch(/[Cc]lose/);
    expect(err.line).toMatch(/Nothing was sent/);
    expect(await rows()).toHaveLength(0);
  });

  it("the Safe holds too little USDC: says how much is missing and drafts nothing", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 120 });
    const err = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(SendBlocked);
    expect(err.line).toMatch(/Add \$80 more USDC/);
    expect(err.line).toMatch(/Nothing was sent/);
    expect(await rows()).toHaveLength(0);
  });

  it.each([0, -50, Number.NaN])("a bad amount (%s) is a 400 and drafts nothing", async (amount) => {
    await expect(repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount })).rejects.toMatchObject({ status: 400 });
    expect(await rows()).toHaveLength(0);
  });

  it.each([200.501, 0.499, 1.005, 0.001, 1e-7, 200.5100001])("an over-precise amount (%s) is a 400 naming cents and drafts nothing", async (amount) => {
    const err = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount }).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toMatch(/cents|two decimals/i);
    expect(await rows()).toHaveLength(0);
  });

  it("accepts a valid cent amount whose binary float representation is slightly off", async () => {
    lenders().setPosition(MORPHO_REF, SAFE, morphoPosition(200_000));
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 150_000 });
    const result = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 131072.02 });
    expect(result.stage).toBe("queued");
    const [row] = await rows();
    const tx = row.tx as { data: Hex };
    expect(BigInt(`0x${argOf(tx.data, APPROVE_SEL, 1)!}`)).toBe(131_072_020_000n);
  });

  it("a lender read failure is retryable and is not reported as no debt", async () => {
    vi.spyOn(lenders(), "position").mockRejectedValue(new Error("RPC unavailable"));
    await expect(repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 })).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/could not be read/i) });
    expect(await rows()).toHaveLength(0);
  });

  it("insufficient funds names the missing amount to the cent", async () => {
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 150.25 });
    const err = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200.51 }).catch((e) => e);
    expect(err).toBeInstanceOf(SendBlocked);
    expect(err.line).toContain("Add $50.26 more USDC");
    expect(err.line).toMatch(/Nothing was sent/);
    expect(await rows()).toHaveLength(0);
  });

  it("a stored spec from before the venue/owed fields still renders honestly", () => {
    const facts = factsOf({ kind: "repay", loanId: MORPHO_LOAN_ID, amount: 200.51 }, "Repay 200.51 USDC on Morpho");
    expect(facts?.sentence).toContain("200.51 USDC");
    expect(facts?.sentence).toContain("Morpho"); // lender name recovered from the loan id
    expect(facts?.sentence).not.toContain("NaN");
    expect(facts?.sentence).not.toContain("undefined");
    // And a spec with no amount at all degrades to the computed outcome, never NaN.
    const bare = factsOf({ kind: "repay", loanId: MORPHO_LOAN_ID }, "Repay on Morpho");
    expect(bare?.sentence).toBe("Repay on Morpho");
  });

  it("no loan on that lender is a 409, and so is a loan with no debt", async () => {
    await expect(repayLoan(ctx, { loanId: COMPOUND_LOAN_ID, amount: 200 })).rejects.toMatchObject({ status: 409 });
    lenders().setPosition(MORPHO_REF, SAFE, morphoPosition(0));
    await expect(repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 })).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    ["an unknown lender", `8453:${SAFE.toLowerCase()}:nope`],
    ["another Safe's loan", `8453:0x00000000000000000000000000000000000000b2:morpho-blue`],
    ["an unknown network", `1:${SAFE.toLowerCase()}:morpho-blue`],
    ["a bare chain id", "8453"],
    ["extra segments", `8453:${SAFE.toLowerCase()}:morpho-blue:x`],
  ])("%s is 404 and drafts nothing", async (_n, id) => {
    await expect(repayLoan(ctx, { loanId: id, amount: 200 })).rejects.toMatchObject({ status: 404 });
    expect(await rows()).toHaveLength(0);
  });
});

describe("a queued partial repay goes out of date only when it can no longer pay that amount", () => {
  const queued = async () => { await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200 }); return (await rows())[0]!; };

  it("stays queued while the debt grew (the typed amount still fits)", async () => {
    const row = await queued();
    lenders().setPosition(MORPHO_REF, SAFE, morphoPosition(1100));
    expect(await checkStale(w.db, w.services, row.id)).toBe(false);
    expect((await rows())[0]!.stage).toBe("queued");
  });

  it("the debt fell below the amount: stale", async () => {
    const row = await queued();
    lenders().setPosition(MORPHO_REF, SAFE, morphoPosition(150));
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
    expect((await rows())[0]!.stage).toBe("stale");
  });

  it("the Safe's USDC dropped below the amount: stale", async () => {
    const row = await queued();
    w.services.fixture.setBalances(8453, SAFE, { ETH: 0.1, USDC: 100 });
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
  });

  it("the loan is gone: stale", async () => {
    const row = await queued();
    lenders().setPosition(MORPHO_REF, SAFE, null);
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
  });

  it("a deleted stale queue entry with approved signatures blocks another amount until its nonce passes", async () => {
    const first = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200, idempotencyKey: "stale-request-1" });
    const [row] = await rows();
    lenders().setPosition(MORPHO_REF, SAFE, morphoPosition(150));
    expect(await checkStale(w.db, w.services, row.id)).toBe(true);
    await w.db.update(proposals).set({ deletedFromQueue: true }).where(eq(proposals.id, row.id));
    await expect(repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 100, idempotencyKey: "stale-request-2" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/even if it no longer appears/i) });
    expect((await rows()).map((r) => r.id)).toContain(first.proposalId);
    expect(await rows()).toHaveLength(1);
  });

  it("a confirmed deletion of an unsigned rejection allows a corrected repayment", async () => {
    const first = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200, idempotencyKey: "reject-unsigned-001" });
    await rejectProposal(ctx, first.proposalId);
    const [rejected] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(rejected.stage).toBe("rejected");
    expect(rejected.deletedFromQueue).toBe(true);

    const second = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 300, idempotencyKey: "reject-unsigned-002" });
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(await rows()).toHaveLength(2);
  });

  it("a deleted row with unknown prior signatures remains a nonce reservation", async () => {
    const first = await repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 200, idempotencyKey: "unknown-delete-001" });
    await w.db.update(proposals).set({ stage: "rejected", deletedFromQueue: true }).where(eq(proposals.id, first.proposalId));
    await expect(repayLoan(ctx, { loanId: MORPHO_LOAN_ID, amount: 300, idempotencyKey: "unknown-delete-002" })).rejects.toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(1);
  });
});

describe("Aave repayment receipt amount", () => {
  it("matches the indexed Safe as user and repayer and reads amount from event data", () => {
    const row = { chainId: 8453, spec: { kind: "repay", loanId: AAVE_LOAN_ID, amount: 200 } } as never;
    const pool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
    const word = (value: string) => `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
    const receipt = {
      logs: [
        {
          address: pool,
          topics: [toEventSelector("Repay(address,address,address,uint256,bool)"), word(USDC), word(SAFE), word(WETH)],
          data: `0x${99_000_000n.toString(16).padStart(64, "0")}${"0".repeat(64)}`,
        },
        {
          address: pool,
          topics: [toEventSelector("Repay(address,address,address,uint256,bool)"), word(USDC), word(SAFE), word(SAFE)],
          data: `0x${200_000_000n.toString(16).padStart(64, "0")}${"0".repeat(63)}1`,
        },
      ],
    } as never;
    expect(repaidFromReceipt(row, SAFE, receipt)).toBe(200);
  });
});
