// BP-36 to BP-38 and E2E-11 on the MOCK stack: the fixture chain, the fake Transaction Service, a recorded-shape aggregator
// (src/server/mock/moves-fixtures) and a scripted destination chain. No live call. The loan on the destination is not quotable in
// this build (lenders are on Base only), so the loan draft is the injected one, which records what it is asked for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_PRICES, VENUES } from "../fixtures/legacy-data";
import { createSafe, deposit } from "@/lib/networks";
import { buildProposal } from "@/lib/proposals";
import { listActivity } from "@/server/activity";
import { loadThread } from "@/server/agent/persist";
import { activity, moves, proposals, safes } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_COSIGNER_KEY, MOCK_OWNER, MOCK_OWNER_KEY, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { mockConfirm, mockExecute } from "@/server/mock/safe-wallet";
import { arrivedLine } from "@/server/moves/copy";
import { planBlockDraft, setMoveDepsForTests, type MoveDeps } from "@/server/moves/deps";
import { MOVE_QUOTE_TTL_MS, OUT_OF_DATE_LINE } from "@/server/moves/expiry";
import { DEST_TX, STATUS } from "@/server/mock/moves-fixtures/status";
import { chainOf, MOVE_NETWORKS } from "@/server/moves/networks";
import { planCrossNetwork } from "@/server/moves/plan";
import { draftMove, getMove, moveView, runMovesTick, sendMove, type StoredMoveSpec } from "@/server/moves/service";
import { fakeAggregator, fakeDestination, statusOf } from "@/server/moves/testing";
import { USDC } from "@/server/moves/tokens";
import { quoteFromJson, quoteToJson, type AggregatorQuote, type QuoteParams } from "@/server/moves/types";
import { followOpenProposals } from "@/server/proposals/follow";
import { deliver, nextNonce, SendBlocked } from "@/server/proposals/send";
import { safeContext } from "@/server/request";
import { delegateTypedData, safeTxHash, safeTxTypedData } from "@/server/safe/hash";
import { newSafeSetup } from "@/server/safe/setup";
import type { Address, Hex, SafeTx } from "@/shared/types";
import { GET as SIGN_DATA } from "@/app/api/safes/[address]/proposals/[id]/sign-data/route";
import { POST as CONFIRM } from "@/app/api/safes/[address]/proposals/[id]/confirm/route";
import { GET as EXECUTE_DATA } from "@/app/api/safes/[address]/proposals/[id]/execute-data/route";
import { createTestWorld, type TestWorld } from "../helpers/world";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const T0 = Date.parse("2026-11-14T10:00:00Z");
const MIN = 60_000;
let w: TestWorld;
let ctx: Awaited<ReturnType<typeof safeContext>>;
let safeId: number;
let clock = T0;
let agg: ReturnType<typeof fakeAggregator>;
let dest: ReturnType<typeof fakeDestination>;
let setups: { chainId: number; safe: string }[];
let loanDrafts: { arrivedUnits: number; borrow: number }[];
let deps: MoveDeps;
const fake = () => w.services.fakes.get(8453)!;

const owner = { address: "0x7be2a91c4d05f3e8b6a7c1d92e04f58a3b6cc41a", ownerCount: 1, threshold: 1 };
const onBase = deposit(createSafe({ id: "s", name: "S", ...owner, networks: ["ethereum", "base"] }), "base", { ETH: 5 });

async function plan(cash = 7500) {
  const p = await planCrossNetwork({ aggregator: agg, networks: MOVE_NETWORKS, chainOf }, { safe: onBase, safeAddress: SAFE, need: { cash, months: 12, targetHf: 1.6, asset: "ETH", network: "base" }, prices: BASE_PRICES, venues: VENUES, loans: [] });
  return p!;
}
const draft = async () => draftMove(w.db, { safeId, safeAddress: SAFE, plan: await plan(), now: new Date(clock), wallet: MOCK_OWNER, destination: dest });
const thread = async () => await loadThread(w.db, safeId);
const texts = async () => (await thread()).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
const status = async (id: string) => (await getMove(w.db, safeId, id)).status;
const tick = () => runMovesTick(w.db, w.services, deps);

/** Draft, send, both owners sign, execute in Safe, and let the follower and the move job see it. */
async function sentAndExecuted() {
  const row = await draft();
  const r = await sendMove(ctx, row.id, deps);
  const [p] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
  mockConfirm(w.services, 8453, p.safeTxHash as Hex, MOCK_COSIGNER);
  await mockExecute(w.services, 8453, p.safeTxHash as Hex);
  await followOpenProposals(w.db, w.services);
  clock += MIN;
  await tick();
  expect(await status(row.id)).toBe("bridging");
  const moved = await getMove(w.db, safeId, row.id);
  return { row: moved, proposalId: r.proposalId, source: moved.sourceTxHash as Hex };
}

beforeEach(async () => {
  clock = T0;
  w = await createTestWorld();
  safeId = await w.trackSafe(MOCK_SAFE, { agentAdded: true, setup: newSafeSetup({ owners: [MOCK_OWNER, MOCK_COSIGNER], threshold: 2, saltNonce: "1" }) });
  const { cookie } = await w.signIn(MOCK_OWNER);
  await fake().addDelegate({ safe: SAFE, delegate: w.services.signer.address, delegator: MOCK_OWNER, label: "Lender agent", signature: await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address)) });
  ctx = await safeContext(w.req("/", { cookie }), MOCK_SAFE, w.services);
  agg = fakeAggregator({ now: () => clock, durationSec: 600 });
  dest = fakeDestination();
  setups = [];
  loanDrafts = [];
  deps = {
    aggregator: agg, destination: dest, now: () => new Date(clock),
    simulate: async () => ({ ok: true, feeUsd: 0.02 }),
    // Like setupViaSafeCreate: deploys the stored setup's owners; an already-deployed Safe keeps its own.
    setupSafe: async (_db, chainId, safe) => {
      setups.push({ chainId, safe });
      if (!dest.deployed.has(`${chainId}:${safe.toLowerCase()}`)) dest.setOwners(chainId, safe, [MOCK_OWNER, MOCK_COSIGNER]);
      return { ok: true };
    },
    draftLoan: async (c, m) => { loanDrafts.push({ arrivedUnits: m.arrivedUnits, borrow: m.then.borrow }); return [{ type: "data-block", data: { block: { kind: "plan", cash: m.then.borrow, asset: m.then.asset, network: m.then.network, venueId: m.then.venueId } } }]; },
  };
  setMoveDepsForTests(deps);
});
afterEach(() => { setMoveDepsForTests(undefined); vi.restoreAllMocks(); w.reset(); });

describe("BP-37 move proposal with expiry", () => {
  it("sends step 1 of 2: the Safe is set up on the destination first, the recipient is the Safe, the text says you still hold it", async () => {
    const row = await draft();
    const view = moveView(row, new Date(clock));
    expect(view.canSend).toBe(true);
    expect(view.outcome).toContain("You still hold it");
    expect(view.reason).toMatch(/^No lender on Base can lend/);
    const r = await sendMove(ctx, row.id, deps);
    expect(r.stage).toBe("queued");
    expect(r.receipt).toMatch(/^Sent to your Safe: Move [\d.]+ ETH to Ethereum \(step 1 of 2\)\.$/);
    expect(setups).toEqual([{ chainId: 1, safe: SAFE }]);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(p.chainId).toBe(8453);
    expect(p.outcome).toContain("You still hold it");
    // The stored transaction is the quote's own call, and its BridgeData receiver is the same Safe.
    const q = quoteFromJson((await getMove(w.db, safeId, row.id)).quote);
    const tx = p.tx as { to: string; data: string; value: string };
    expect(tx.data.toLowerCase()).toContain(q.tx.data.slice(2).toLowerCase());
    expect(q.tx.data.toLowerCase()).toContain(SAFE.slice(2).toLowerCase());
    expect(await status(row.id)).toBe("queued");
    expect((await w.db.select().from(activity).where(eq(activity.safeId, safeId))).some((a) => a.kind === "proposed")).toBe(true);
  });

  it("a second press is the same proposal", async () => {
    const row = await draft();
    const a = await sendMove(ctx, row.id, deps);
    const b = await sendMove(ctx, row.id, deps);
    expect(b.proposalId).toBe(a.proposalId);
    expect(await w.db.select().from(proposals)).toHaveLength(1);
  });

  it("refuses calldata whose recipient is not the Safe: nothing is stored, nothing is set up", async () => {
    const row = await draft();
    const q = quoteToJson(quoteFromJson(row.quote));
    const stranger = "00000000000000000000000000000000000dEaD1".toLowerCase();
    q.tx.data = q.tx.data.toLowerCase().replaceAll(SAFE.slice(2).toLowerCase(), stranger) as Hex;
    await w.db.update(moves).set({ quote: q }).where(eq(moves.id, row.id));
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(/receiver/);
    await expect(sendMove(ctx, row.id, deps)).rejects.toBeInstanceOf(SendBlocked);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    expect(setups).toEqual([]);
  });

  it("refuses a stored destination that differs from the request before calling destination setup", async () => {
    const row = await draft();
    const spec = row.spec as StoredMoveSpec;
    await w.db.update(moves).set({
      spec: { ...spec, move: { ...spec.move, to: "arbitrum" } },
    }).where(eq(moves.id, row.id));
    const setupSafe = vi.spyOn(deps, "setupSafe");

    await expect(sendMove(ctx, row.id, deps)).rejects.toBeInstanceOf(SendBlocked);
    expect(setupSafe).not.toHaveBeenCalled();
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it("does not send when the Safe cannot be set up on the destination", async () => {
    deps.setupSafe = async () => ({ ok: false, reason: "Your Safe is not set up on Ethereum yet. Set it up first (about $12), then send the move." });
    const row = await draft();
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(/not set up on Ethereum/);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it("does not send when the test run fails", async () => {
    deps.simulate = async () => ({ ok: false, failedStep: 1, feeUsd: 0 });
    const row = await draft();
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(/test run failed at step 2/);
  });

  it("the quote ran out before sending: Out of date, nothing sent, a fresh draft offered", async () => {
    const row = await draft();
    clock += MOVE_QUOTE_TTL_MS;
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(OUT_OF_DATE_LINE);
    expect(moveView(await getMove(w.db, safeId, row.id), new Date(clock))).toMatchObject({ outOfDate: true, canSend: false, sentence: OUT_OF_DATE_LINE });
    const old = await getMove(w.db, safeId, row.id);
    expect(old.status).toBe("expired");
    const fresh = await getMove(w.db, safeId, old.replacedBy!);
    expect(fresh.status).toBe("quoted");
    expect(fresh.expiresAt.getTime()).toBe(clock + MOVE_QUOTE_TTL_MS);
    expect((await thread()).some((m) => m.parts.some((p) => p.type === "data-move" && (p as { data: { moveId: string } }).data.moveId === fresh.id))).toBe(true);
  });

  it("the quote ran out in the queue: the card reads Out of date, the old one is deleted from the Safe queue, a fresh draft is offered", async () => {
    const row = await draft();
    const r = await sendMove(ctx, row.id, deps);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(await fake().getMultisigTransaction(p.safeTxHash as Hex)).not.toBeNull();
    clock += MOVE_QUOTE_TTL_MS + 1;
    await tick();
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(after.stage).toBe("stale");
    expect(after.deletedFromQueue).toBe(true);
    expect(await fake().getMultisigTransaction(p.safeTxHash as Hex)).toBeNull();
    const old = await getMove(w.db, safeId, row.id);
    expect(old.status).toBe("expired");
    expect(old.replacedBy).toBeTruthy();
    expect((await texts()).some((t) => /ran out before it was signed.*fresh draft/.test(t))).toBe(true);
    // Running again changes nothing.
    await tick();
    expect(await w.db.select().from(moves)).toHaveLength(2);
    expect((await listActivity(w.db, safeId)).filter((a) => /out of date/.test(a.text))).toHaveLength(1);
  });

  it("a proposal already executed when the quote runs out is followed, not expired", async () => {
    const row = await draft();
    const r = await sendMove(ctx, row.id, deps);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    mockConfirm(w.services, 8453, p.safeTxHash as Hex, MOCK_COSIGNER);
    await mockExecute(w.services, 8453, p.safeTxHash as Hex);
    await followOpenProposals(w.db, w.services);
    clock += MOVE_QUOTE_TTL_MS + MIN;
    await tick();
    const after = await getMove(w.db, safeId, row.id);
    expect(after.status).toBe("bridging");
    expect(after.sourceTxHash).toBeTruthy();
    expect(after.replacedBy).toBeNull();
  });

  it("a proposal someone already signed is not deleted: it stays in the queue and the text says to reject it in Safe", async () => {
    const row = await draft();
    const r = await sendMove(ctx, row.id, deps);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    mockConfirm(w.services, 8453, p.safeTxHash as Hex, MOCK_COSIGNER);
    await followOpenProposals(w.db, w.services);
    clock += MOVE_QUOTE_TTL_MS + 1;
    await tick();
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(after.stage).toBe("stale");
    expect(after.deletedFromQueue).toBe(false);
    expect((await texts()).some((t) => /reject it in Safe too/.test(t))).toBe(true);
  });

  it("no route for the fresh quote: the agent says so and drafts nothing", async () => {
    const row = await draft();
    clock += MOVE_QUOTE_TTL_MS;
    agg.quote = async () => null;
    await tick();
    expect((await getMove(w.db, safeId, row.id)).replacedBy).toBeNull();
    expect((await texts()).some((t) => /no route for it right now/.test(t))).toBe(true);
  });
});

// Once a move is queued, the owner routes re-run the delivery gate: sign-data, confirm and
// execute-data all refuse with 409 when the move would no longer be delivered. The gate is
// read-only: a refusal leaves the proposal queued, its nonce held, its Safe-service record untouched.
describe("a queued move is re-checked at the owner sign, confirm and execute routes", () => {
  const ownerAcct = privateKeyToAccount(MOCK_OWNER_KEY);
  const cosignerAcct = privateKeyToAccount(MOCK_COSIGNER_KEY);
  let ownerCookie: string;
  let cosignerCookie: string;

  beforeEach(async () => {
    ownerCookie = (await w.signIn(MOCK_OWNER)).cookie;
    cosignerCookie = (await w.signIn(MOCK_COSIGNER)).cookie;
  });

  const params = (id: string) => ({ params: Promise.resolve({ address: MOCK_SAFE, id }) });
  const signData = (id: string, cookie: string) => SIGN_DATA(w.req(`/api/safes/${MOCK_SAFE}/proposals/${id}/sign-data`, { cookie }), params(id));
  const confirm = (id: string, cookie: string, signature: unknown) => CONFIRM(w.req(`/api/safes/${MOCK_SAFE}/proposals/${id}/confirm`, { method: "POST", cookie, json: { signature } }), params(id));
  const execData = (id: string, cookie: string) => EXECUTE_DATA(w.req(`/api/safes/${MOCK_SAFE}/proposals/${id}/execute-data`, { cookie }), params(id));

  const queuedMove = async () => {
    const move = await draft();
    const sent = await sendMove(ctx, move.id, deps);
    expect(sent.stage).toBe("queued");
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, sent.proposalId));
    expect(p.stage).toBe("queued");
    return { move, proposalId: sent.proposalId, proposal: p };
  };

  /** Queued and execute-ready: one cosigner confirmation through the route; the sender's own v=1 completes 2-of-2. */
  const executeReady = async () => {
    const { move, proposalId, proposal } = await queuedMove();
    const tx = proposal.tx as SafeTx;
    const typed = safeTxTypedData(8453, SAFE, tx);
    expect((await confirm(proposalId, cosignerCookie, await cosignerAcct.signTypedData(typed))).status).toBe(200);
    const exec = await (await execData(proposalId, ownerCookie)).json();
    expect(exec).toMatchObject({ ready: true, includesYourApproval: true });
    expect(exec.data).toMatch(/^0x/);
    return { move, proposalId, proposal, typed };
  };

  /** Every owner route's status, captured before any assertion so one refusal cannot mask another's. */
  const refuseAll = async (proposalId: string, signature: Hex, reason: RegExp) => {
    const rs = await Promise.all([
      signData(proposalId, ownerCookie),
      confirm(proposalId, ownerCookie, signature),
      execData(proposalId, ownerCookie),
    ]);
    expect(rs.map((res) => res.status)).toEqual([409, 409, 409]);
    for (const res of rs) {
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["error"]); // no typed data, calldata or signatures
      expect(body.error).toMatch(reason);
    }
  };

  const expectPreserved = async (proposalId: string, proposal: typeof proposals.$inferSelect, moveId: string) => {
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(after.stage).toBe("queued");
    expect(after.nonce).toBe(proposal.nonce);
    expect(after.safeTxHash).toBe(proposal.safeTxHash);
    expect(await fake().getMultisigTransaction(proposal.safeTxHash as Hex)).not.toBeNull();
    expect((await getMove(w.db, safeId, moveId)).proposalId).toBe(proposalId);
  };

  it("hands out typed data, takes both owners' signatures and returns calldata while the move still passes", async () => {
    const { proposalId, proposal } = await queuedMove();
    const tx = proposal.tx as SafeTx;
    const typed = safeTxTypedData(8453, SAFE, tx);
    const asJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

    const sd = await signData(proposalId, ownerCookie);
    expect(sd.status).toBe(200);
    const sign = await sd.json();
    expect(sign.safeTxHash).toBe(proposal.safeTxHash);
    expect(sign.canSign).toBe(true);
    expect(sign.typedData).toEqual({ domain: asJson(typed.domain), types: typed.types, primaryType: "SafeTx", message: asJson(typed.message) });

    // The proposal creator signs through the route; the second source owner does the same (they need not be the creator).
    expect((await confirm(proposalId, ownerCookie, await ownerAcct.signTypedData(typed))).status).toBe(200);
    expect((await confirm(proposalId, cosignerCookie, await cosignerAcct.signTypedData(typed))).status).toBe(200);
    expect((await fake().getMultisigTransaction(proposal.safeTxHash as Hex))!.confirmations).toHaveLength(2);

    const ed = await execData(proposalId, ownerCookie);
    expect(ed.status).toBe(200);
    const exec = await ed.json();
    expect(exec.ready).toBe(true);
    expect(exec.data).toMatch(/^0x/);
    expect(exec.signatures).toMatch(/^0x/);
    expect(exec.nonce.tx).toBe(tx.nonce);
  });

  it("refuses all three routes once the destination Safe no longer answers to the proposal creator", async () => {
    const { move, proposalId, proposal, typed } = await executeReady();
    const confirmations = () => fake().getMultisigTransaction(proposal.safeTxHash as Hex).then((t) => t!.confirmations.length);
    const before = await confirmations();
    const serviceWrite = vi.spyOn(fake(), "confirmTransaction");

    dest.setOwners(1, SAFE, [MOCK_COSIGNER]); // the cosigner still owns it; the creator does not — the check follows the creator
    await refuseAll(proposalId, await ownerAcct.signTypedData(typed), /owned by a different wallet/);

    expect(serviceWrite).not.toHaveBeenCalled();
    expect(await confirmations()).toBe(before);
    await expectPreserved(proposalId, proposal, move.id);
  });

  it("refuses all three routes once the move's quote ran out", async () => {
    const { move, proposalId, proposal, typed } = await executeReady();
    const serviceWrite = vi.spyOn(fake(), "confirmTransaction");

    clock = move.expiresAt.getTime(); // the exact boundary: isMoveStale reads >=
    await refuseAll(proposalId, await ownerAcct.signTypedData(typed), /quote ran out/);

    expect(serviceWrite).not.toHaveBeenCalled();
    expect((await fake().getMultisigTransaction(proposal.safeTxHash as Hex))!.confirmations).toHaveLength(1);
    await expectPreserved(proposalId, proposal, move.id);
  });

  it("refuses a stored transaction that drifted from the checked quote batch, even with its hash rebound", async () => {
    const { move, proposalId, proposal } = await queuedMove();
    // The persisted Safe transaction no longer matches the quote batch — the move invariant, not the
    // generic hash check: the stored hash is rebound and a co-signer's on-chain approval is recorded.
    const tx = { ...(proposal.tx as SafeTx), data: "0xdeadbeef" as Hex };
    await w.db.update(proposals).set({
      tx, safeTxHash: safeTxHash(8453, SAFE, tx),
      confirmations: [{ owner: MOCK_COSIGNER, submittedAt: new Date(clock).toISOString() }],
    }).where(eq(proposals.id, proposalId));
    const serviceWrite = vi.spyOn(fake(), "confirmTransaction");

    await refuseAll(proposalId, await ownerAcct.signTypedData(safeTxTypedData(8453, SAFE, tx)), /does not match the checked calls/);

    expect(serviceWrite).not.toHaveBeenCalled();
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(after.stage).toBe("queued");
    expect(after.nonce).toBe(proposal.nonce);
    expect((await getMove(w.db, safeId, move.id)).proposalId).toBe(proposalId);
  });
});

describe("a re-draft needs a fresh quote that answers the expired quote's request", () => {
  const OTHER_SAFE: Address = "0x9f8da0c9d4a1c6f92e7b51d30a8e2c04f6b37d12";
  /** expireMove asks the aggregator again for the expired quote's pair, tokens, amount and Safe; these answer a different request. */
  const wrongRequest: Record<string, (p: QuoteParams) => QuoteParams> = {
    "source network": (p) => ({ ...p, fromChain: 10 }),
    "destination network": (p) => ({ ...p, toChain: 10 }),
    "tokens": (p) => ({ ...p, fromToken: USDC[8453]!, toToken: USDC[1]! }),
    "source amount": (p) => ({ ...p, fromAmount: p.fromAmount * 2n }),
    "Safe": (p) => ({ ...p, address: OTHER_SAFE }),
  };
  /** A response whose metadata substitutes what the request carried (the calldata still reads as the request's). */
  const wrongAnswer: Record<string, (q: AggregatorQuote) => AggregatorQuote> = {
    "source token decimals": (q) => ({ ...q, fromDecimals: 8 }),
    "destination token decimals": (q) => ({ ...q, toDecimals: 8 }),
  };

  /** Draft, let the quote run out, then answer the re-quote with `answer`. No replacement may be drafted. */
  const expireAgainst = async (answer: (p: QuoteParams) => Promise<AggregatorQuote | null>) => {
    const row = await draft();
    clock += MOVE_QUOTE_TTL_MS;
    agg.quote = answer;
    await tick();
    const old = await getMove(w.db, safeId, row.id);
    expect(old.status).toBe("expired");
    expect(old.replacedBy).toBeNull();
    expect(await w.db.select().from(moves)).toHaveLength(1);
    expect((await texts()).some((t) => /no route for it right now/.test(t))).toBe(true);
  };

  it("asks the aggregator for the expired quote's exact pair, tokens, amount and Safe", async () => {
    const row = await draft();
    const asked = quoteFromJson(row.quote);
    clock += MOVE_QUOTE_TTL_MS;
    const seen: QuoteParams[] = [];
    const real = agg.quote.bind(agg);
    agg.quote = async (p) => { seen.push(p); return real(p); };
    await tick();
    expect(seen).toHaveLength(1);
    const p = seen[0]!;
    expect(p.fromChain).toBe(row.fromChain);
    expect(p.toChain).toBe(row.toChain);
    expect(p.fromToken.toLowerCase()).toBe(asked.fromToken.toLowerCase());
    expect(p.toToken.toLowerCase()).toBe(asked.toToken.toLowerCase());
    expect(p.fromAmount).toBe(asked.fromAmount);
    expect(p.address.toLowerCase()).toBe(SAFE.toLowerCase());
    expect((await getMove(w.db, safeId, row.id)).replacedBy).toBeTruthy(); // a quote that answers gets its draft
  });

  for (const [field, patch] of Object.entries(wrongRequest)) {
    it(`drafts nothing when the fresh quote answers a different ${field}`, async () => {
      const real = agg.quote.bind(agg);
      await expireAgainst((p) => real(patch(p)));
    });
  }
  for (const [field, patch] of Object.entries(wrongAnswer)) {
    it(`drafts nothing when the fresh quote's metadata substitutes the ${field}`, async () => {
      const real = agg.quote.bind(agg);
      await expireAgainst(async (p) => { const q = await real(p); return q ? patch(q) : q; });
    });
  }
});

describe("the destination Safe at the same address must be the wallet's too", () => {
  const C: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // another wallet, not the session's

  it.each([[[MOCK_STRANGER]], [[C]], [[MOCK_STRANGER, C]]] as const)("refuses to draft when the deployed destination Safe is owned by %s", async (owners) => {
    dest.setOwners(1, SAFE, [...owners]);
    await expect(draft()).rejects.toThrow(/not an owner of this Safe on Ethereum/);
    expect(await w.db.select().from(moves)).toHaveLength(0);
  });

  it("drafts and sends when the wallet owns the Safe on both networks", async () => {
    dest.setOwners(1, SAFE, [MOCK_OWNER]);
    const row = await draft();
    const r = await sendMove(ctx, row.id, deps);
    expect(r.stage).toBe("queued");
    expect(setups).toEqual([{ chainId: 1, safe: SAFE }]);
  });

  it("drafts and sends to an undeployed destination when the stored creation setup lists the wallet", async () => {
    const row = await draft();
    const r = await sendMove(ctx, row.id, deps);
    expect(r.stage).toBe("queued");
  });

  it("refuses to draft an undeployed destination whose stored setup lists someone else", async () => {
    await w.db.update(safes).set({ setup: newSafeSetup({ owners: [MOCK_STRANGER], threshold: 1, saltNonce: "2" }) }).where(eq(safes.id, safeId));
    await expect(draft()).rejects.toThrow(/not an owner of this Safe on Ethereum/);
    expect(await w.db.select().from(moves)).toHaveLength(0);
  });

  it("refuses the send when destination ownership changed after the draft: nothing is stored, nothing is delivered", async () => {
    dest.setOwners(1, SAFE, [MOCK_OWNER]);
    const row = await draft();
    dest.setOwners(1, SAFE, [MOCK_STRANGER]); // a same-address Safe owned by someone else, between draft and send
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(/owned by a different wallet/);
    await expect(sendMove(ctx, row.id, deps)).rejects.toBeInstanceOf(SendBlocked);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
    expect(await status(row.id)).toBe("quoted");
  });

  it("blocks the send when the same address was deployed by someone else after the draft", async () => {
    const row = await draft(); // undeployed at draft: the setup's owners govern
    dest.setOwners(1, SAFE, [MOCK_STRANGER]);
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(/owned by a different wallet/);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it("a contract that answers getOwners but is not a Safe is refused at draft, and refuses a send", async () => {
    // Deployed code that decodes getOwners to the asking wallet — but is not a Safe: the identity check refuses it.
    dest.setFakeContract(1, SAFE, [MOCK_OWNER]);
    await expect(draft()).rejects.toThrow(/not an owner of this Safe on Ethereum/);
    expect(await w.db.select().from(moves)).toHaveLength(0);

    dest.fakeContracts.delete(`1:${SAFE.toLowerCase()}`);
    dest.setOwners(1, SAFE, [MOCK_OWNER]);
    const row = await draft();
    dest.setFakeContract(1, SAFE, [MOCK_OWNER]); // what is at the address stopped being a verified Safe
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(/could not confirm who owns/);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it("blocks the send when the destination owners cannot be confirmed", async () => {
    const row = await draft();
    dest.deployed.add(`1:${SAFE.toLowerCase()}`); // code at the address, but its owners cannot be read
    await expect(sendMove(ctx, row.id, deps)).rejects.toThrow(/could not confirm who owns/);
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it("keeps an unresolved submission and its nonce when the move quote expires", async () => {
    const row = await draft();
    const propose = vi.spyOn(fake(), "proposeTransaction").mockRejectedValueOnce(new TypeError("timeout"));
    const first = await sendMove(ctx, row.id, deps);
    expect(first.stage).toBe("sending");
    const [proposal] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(propose).toHaveBeenCalledTimes(1);

    await w.db.update(moves).set({ expiresAt: new Date(clock - 1) }).where(eq(moves.id, row.id));
    const retry = await sendMove(ctx, row.id, deps).catch((error) => error);

    expect(retry).not.toBeInstanceOf(SendBlocked);
    expect(retry.stage).toBe("sending");
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(after.stage).toBe("sending");
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe((proposal.nonce ?? 0n) + 1n);
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it("fails closed at draft when the deployment read fails: the stored setup's owners are not trusted", async () => {
    dest.hasCode = async () => { throw new Error("rpc down"); };
    await expect(draft()).rejects.toThrow(/not an owner of this Safe on Ethereum/);
    expect(await w.db.select().from(moves)).toHaveLength(0);
  });

  it.each([
    ["a different wallet", () => dest.setOwners(1, SAFE, [MOCK_STRANGER])],
    ["unverifiable owners", () => dest.owners.delete(`1:${SAFE.toLowerCase()}`)],
  ] as const)("keeps an unresolved submission pending when the destination owners become %s", async (_name, change) => {
    const row = await draft();
    const propose = vi.spyOn(fake(), "proposeTransaction").mockRejectedValueOnce(new TypeError("timeout")); // deliver cannot confirm: the proposal stays "sending"
    const first = await sendMove(ctx, row.id, deps);
    expect(first.stage).toBe("sending");
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("sending");
    expect(propose).toHaveBeenCalledTimes(1);

    change(); // ownership moved while the delivery was unresolved
    const getTx = vi.spyOn(fake(), "getMultisigTransaction");
    const sign = vi.spyOn(w.services.signer, "signProposal");
    const retry = await sendMove(ctx, row.id, deps);
    expect(retry.stage).toBe("sending");
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    // An attempt intent makes the unknown submission sticky: neither a stale owner check nor a
    // worker retry may gate-refuse, close the move, or release nonce zero.
    expect(after.stage).toBe("sending");
    expect(after.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(getTx).toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledTimes(1);
    expect((await sendMove(ctx, row.id, deps)).stage).toBe("sending");
    expect(sign).not.toHaveBeenCalled();
    await tick();
    expect(await status(row.id)).not.toBe("closed");
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
  });
});

describe("the worker's durable submission intent", () => {
  /** First press, delivery outcome unknown: the committed intent stays "sending" until the Safe hash appears. */
  const sendingMove = async () => {
    const row = await draft();
    const propose = vi.spyOn(fake(), "proposeTransaction").mockRejectedValueOnce(new TypeError("timeout"));
    const first = await sendMove(ctx, row.id, deps);
    expect(first.stage).toBe("sending");
    expect(propose).toHaveBeenCalledTimes(1);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("sending");
    return { row, first, propose };
  };

  it("lets concurrent workers poll an in-flight submission without refusing or reposting it", async () => {
    const row = await draft();
    let entered!: () => void;
    const postStarted = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const mayPost = new Promise<void>((resolve) => { release = resolve; });
    const service = fake();
    const real = service.proposeTransaction.bind(service);
    const propose = vi.spyOn(service, "proposeTransaction").mockImplementation(async (p) => {
      entered();
      await mayPost;
      return real(p);
    });

    const firstDelivery = sendMove(ctx, row.id, deps);
    await postStarted;
    const [currentMove] = await w.db.select().from(moves).where(eq(moves.id, row.id));
    const [pending] = await w.db.select().from(proposals).where(eq(proposals.id, currentMove!.proposalId!));
    expect(pending?.submissionAttemptedAt).toBeInstanceOf(Date);
    // Queue a second same-process worker while the claimant is posting. It must wait for the
    // in-process delivery lock, then observe the accepted proposal without a second POST.
    const secondDelivery = deliver(w.db, w.services, pending, SAFE);
    expect(propose).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([firstDelivery, secondDelivery]);
    const [proposal] = await w.db.select().from(proposals).where(eq(proposals.id, currentMove!.proposalId!));
    expect(await fake().getMultisigTransaction(proposal.safeTxHash as Hex)).not.toBeNull();
    expect(proposal.stage).toBe("queued");
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it("keeps an absent submission pending even when its gate still passes", async () => {
    const { first, propose } = await sendingMove();
    await followOpenProposals(w.db, w.services); // reconciliation only polls once intent exists
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("sending");
    expect(p.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(await fake().getMultisigTransaction(p.safeTxHash as Hex)).toBeNull();
  });

  it.each([
    ["a different wallet", () => dest.setOwners(1, SAFE, [MOCK_STRANGER])],
    ["a contract that is not a Safe", () => dest.setFakeContract(1, SAFE, [MOCK_OWNER])],
    ["unverifiable owners", () => dest.owners.delete(`1:${SAFE.toLowerCase()}`)],
  ] as const)("does not release an attempted submission when the destination became %s", async (_name, change) => {
    const { row, first, propose } = await sendingMove();
    change();
    const sign = vi.spyOn(w.services.signer, "signProposal");
    await followOpenProposals(w.db, w.services);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("sending");
    expect(p.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(sign).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(await fake().getMultisigTransaction(p.safeTxHash as Hex)).toBeNull();
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
    await tick();
    expect(await status(row.id)).not.toBe("closed");
  });

  it("does not gate-refuse an attempted submission when the stored quote later fails the validator", async () => {
    const { row, first, propose } = await sendingMove();
    const q = quoteToJson(quoteFromJson(row.quote));
    const stranger = "00000000000000000000000000000000000dEaD1".toLowerCase();
    q.tx.data = q.tx.data.toLowerCase().replaceAll(SAFE.slice(2).toLowerCase(), stranger) as Hex;
    await w.db.update(moves).set({ quote: q }).where(eq(moves.id, row.id));
    const sign = vi.spyOn(w.services.signer, "signProposal");
    await followOpenProposals(w.db, w.services);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("sending");
    expect(p.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(sign).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
  });

  it("does not gate-refuse an attempted submission when its stored transaction changes", async () => {
    const { first, propose } = await sendingMove();
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    const tx = p.tx as { data: string };
    const stranger = "00000000000000000000000000000000000dEaD1".toLowerCase();
    tx.data = tx.data.toLowerCase().replaceAll(SAFE.slice(2).toLowerCase(), stranger);
    await w.db.update(proposals).set({ tx }).where(eq(proposals.id, p.id));
    const sign = vi.spyOn(w.services.signer, "signProposal");
    await followOpenProposals(w.db, w.services);
    const [after] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(after.stage).toBe("sending");
    expect(after.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(sign).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledTimes(1);
  });

  /** Simulate a pre-upgrade move row whose displayed request no longer matches the stored quote. */
  const mismatchedDraft = async (field: "token" | "amount") => {
    const row = await draft();
    if (field === "token") {
      const spec = row.spec as StoredMoveSpec;
      await w.db.update(moves).set({
        asset: "wstETH",
        spec: { ...spec, move: { ...spec.move, asset: "wstETH" } },
      }).where(eq(moves.id, row.id));
    } else {
      const quote = quoteFromJson(row.quote);
      const amount = quote.fromAmount + 1n;
      await w.db.update(moves).set({
        quote: quoteToJson({ ...quote, fromAmount: amount, tx: { ...quote.tx, value: amount } }),
      }).where(eq(moves.id, row.id));
    }
    return row;
  };

  it.each(["token", "amount"] as const)("does not deliver a pre-upgrade draft whose quote differs from the requested %s", async (field) => {
    const row = await mismatchedDraft(field);
    const sign = vi.spyOn(w.services.signer, "signProposal");
    const propose = vi.spyOn(fake(), "proposeTransaction");
    await expect(sendMove(ctx, row.id, deps)).rejects.toBeInstanceOf(SendBlocked);
    expect(sign).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(await w.db.select().from(proposals)).toHaveLength(0);
  });

  it.each(["token", "amount"] as const)("does not refresh an expired pre-upgrade draft whose quote differs from the requested %s", async (field) => {
    const row = await mismatchedDraft(field);
    clock += MOVE_QUOTE_TTL_MS;
    const quote = vi.spyOn(agg, "quote");
    await tick();
    expect(quote).not.toHaveBeenCalled();
    const old = await getMove(w.db, safeId, row.id);
    expect(old.status).toBe("expired");
    expect(old.replacedBy).toBeNull();
    expect(await w.db.select().from(moves)).toHaveLength(1);
  });

  it("keeps an attempted submission and nonce when the quote runs out", async () => {
    const { row, first, propose } = await sendingMove();
    clock += MOVE_QUOTE_TTL_MS + 1; // the quote ran out while the delivery was unresolved
    const sign = vi.spyOn(w.services.signer, "signProposal");
    await followOpenProposals(w.db, w.services);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("sending");
    expect(p.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(sign).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(await fake().getMultisigTransaction(p.safeTxHash as Hex)).toBeNull();
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
    await tick();
    expect(await status(row.id)).not.toBe("closed");
  });

  it("a manual retry after the quote ran out only polls the existing intent", async () => {
    const { row, first, propose } = await sendingMove();
    clock += MOVE_QUOTE_TTL_MS + 1;
    const sign = vi.spyOn(w.services.signer, "signProposal");
    expect((await sendMove(ctx, row.id, deps)).stage).toBe("sending");
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("sending");
    expect(p.submissionAttemptedAt).toBeInstanceOf(Date);
    expect(sign).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(1n);
  });

  it("a proposal the service already has is queued even when the gate would refuse now", async () => {
    const row = await draft();
    // Accepted at the service, then the response was lost: the postflight poll sees it immediately.
    const real = fake().proposeTransaction.bind(fake());
    vi.spyOn(fake(), "proposeTransaction").mockImplementationOnce(async (p) => {
      await real(p);
      throw new TypeError("response lost");
    });
    const first = await sendMove(ctx, row.id, deps);
    expect(first.stage).toBe("queued");
    dest.setOwners(1, SAFE, [MOCK_STRANGER]); // the gate would refuse now
    const sign = vi.spyOn(w.services.signer, "signProposal");
    await followOpenProposals(w.db, w.services);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, first.proposalId));
    expect(p.stage).toBe("queued"); // the service's own answer wins: it is already in the Safe queue
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("BP-38 arrival, then the loan draft; and failure (M5 exit 2)", () => {
  it("done and complete, destination transaction confirmed: arrival message, then the loan draft from the arrived amount; once", async () => {
    const { row, source } = await sentAndExecuted();
    const q = quoteFromJson(row.quote);
    agg.statuses.set(source.toLowerCase(), { ...statusOf("done"), receiving: { ...statusOf("done").receiving!, amount: q.toAmountMin } });
    dest.payments.set(DEST_TX, q.toAmountMin);
    clock += 5 * MIN;
    await tick();
    await tick();
    const units = Number(q.toAmountMin) / 1e18;
    const arrivedMsgs = (await thread()).filter((m) => m.id === `move-arrived-${row.id}`);
    expect(arrivedMsgs).toHaveLength(1);
    expect(arrivedMsgs[0].parts[0]).toEqual({ type: "text", text: arrivedLine(units, "ETH", 1, (row.spec as StoredMoveSpec).then.amount) });
    expect((arrivedMsgs[0].parts[0] as { text: string }).text).toMatch(/^Your [\d.]+ ETH is on Ethereum now, in the same Safe\. Step 2 of 2: sign the loan below\.$/);
    expect(arrivedMsgs[0].parts[1]).toMatchObject({ type: "data-block", data: { block: { kind: "plan", venueId: "compound", network: "ethereum" } } });
    expect(loanDrafts).toEqual([{ arrivedUnits: units, borrow: 7500 }]);
    expect(await status(row.id)).toBe("arrived");
    expect((await getMove(w.db, safeId, row.id)).receivedRaw).toBe(q.toAmountMin.toString());
  });

  it("the library's own done line is the arrival sentence", () => {
    const spec = { kind: "move" as const, safeId: "s", move: { from: "base" as const, to: "ethereum" as const, asset: "ETH" as const, amount: 4.86, feeUsd: 4, minutes: 10 }, then: { kind: "open" as const, venueId: "compound", asset: "ETH" as const, amount: 4.86, borrow: 7500, safeId: "s", network: "ethereum" as const } };
    const lib = buildProposal("m", spec, [], { prices: { ...BASE_PRICES }, venues: VENUES, networks: MOVE_NETWORKS, feeEstimateUsd: 0 }).done;
    expect(arrivedLine(4.86, "ETH", 1, 4.86)).toBe(lib);
  });

  it("less arrived than planned: the loan is planned on what arrived, and the message says so", async () => {
    const { row, source } = await sentAndExecuted();
    const q = quoteFromJson(row.quote);
    const less = (q.toAmountMin * 98n) / 100n;
    agg.statuses.set(source.toLowerCase(), { ...statusOf("doneLess"), receiving: { ...statusOf("doneLess").receiving!, amount: less } });
    dest.payments.set(DEST_TX, less);
    await tick();
    expect(loanDrafts[0].arrivedUnits).toBeCloseTo(Number(less) / 1e18, 9);
    expect((await texts()).some((t) => /Slightly less arrived than planned/.test(t))).toBe(true);
  });

  it("an unrelated deposit of the same asset while pending: no arrival, no loan draft", async () => {
    const { row, source } = await sentAndExecuted();
    agg.statuses.set(source.toLowerCase(), statusOf("pending"));
    dest.payments.set("0x" + "ee".repeat(32), 5n * 10n ** 18n); // someone else's transfer to the Safe
    clock += 2 * MIN;
    await tick();
    expect(await status(row.id)).toBe("bridging");
    expect(loanDrafts).toEqual([]);
    expect((await texts()).some((t) => /is on Ethereum now/.test(t))).toBe(false);
  });

  it("done, but the destination transaction is not confirmed: waits, then arrives when it is", async () => {
    const { row, source } = await sentAndExecuted();
    const q = quoteFromJson(row.quote);
    agg.statuses.set(source.toLowerCase(), { ...statusOf("done"), receiving: { ...statusOf("done").receiving!, amount: q.toAmountMin } });
    await tick();
    expect(await status(row.id)).toBe("bridging");
    expect(loanDrafts).toEqual([]);
    dest.payments.set(DEST_TX, q.toAmountMin);
    await tick();
    expect(await status(row.id)).toBe("arrived");
  });

  it.each([
    ["partial", /only partly completed.*different token.*in your Safe on Ethereum/],
    ["refunded", /was refunded.*back in your Safe on Base/],
    ["failed", /failed.*still on Base or held by the bridge for a refund/],
  ] as const)("%s: says what happened and where the funds are, and drafts no loan", async (name, say) => {
    const { row, source } = await sentAndExecuted();
    agg.statuses.set(source.toLowerCase(), statusOf(name));
    dest.payments.set(DEST_TX, 10n ** 18n); // would pass the on-chain check; must not matter
    await tick();
    await tick();
    expect(await status(row.id)).toBe(name);
    expect(loanDrafts).toEqual([]);
    const said = (await texts()).filter((t) => say.test(t));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("I did not draft a loan");
    expect(said[0]).toContain(source);
  });

  it("never found: pending, then delayed after the quoted time plus a margin, said once; never a failure, never a loan", async () => {
    const { row } = await sentAndExecuted(); // the aggregator knows nothing of this hash
    clock += 10 * MIN; // sent 1 minute ago... the quoted 10 minutes have not passed
    await tick();
    expect(await texts()).not.toContainEqual(expect.stringMatching(/taking longer/));
    clock += 30 * MIN;
    await tick();
    await tick();
    expect((await texts()).filter((t) => /taking longer than the quoted about \d+ minutes/.test(t))).toHaveLength(1);
    expect(await status(row.id)).toBe("bridging");
    expect(loanDrafts).toEqual([]);
    // It can still arrive afterwards.
    const q = quoteFromJson(row.quote);
    agg.statuses.set(row.sourceTxHash!.toLowerCase(), { ...statusOf("done"), receiving: { ...statusOf("done").receiving!, amount: q.toAmountMin } });
    dest.payments.set(DEST_TX, q.toAmountMin);
    await tick();
    expect(await status(row.id)).toBe("arrived");
  });

  it("the move transaction reverted in Safe: nothing moved, you still hold it", async () => {
    const row = await draft();
    const r = await sendMove(ctx, row.id, deps);
    const [p] = await w.db.select().from(proposals).where(eq(proposals.id, r.proposalId));
    mockConfirm(w.services, 8453, p.safeTxHash as Hex, MOCK_COSIGNER);
    await mockExecute(w.services, 8453, p.safeTxHash as Hex, { revert: true });
    await followOpenProposals(w.db, w.services);
    await tick();
    expect(await status(row.id)).toBe("failed");
    expect((await texts()).some((t) => /reverted\. Nothing moved\. You still hold your/.test(t))).toBe(true);
  });

  it("recorded statuses are the shapes the client reads", () => {
    expect(Object.keys(STATUS)).toEqual(["done", "doneLess", "partial", "refunded", "failed", "pending", "notFound"]);
  });
});

describe("E2E-11 funds on one network, the loan needs another (MOCK stack)", () => {
  it("move proposal → both sign → arrival (recorded status, confirmed on the destination) → loan draft", async () => {
    const p = await plan();
    expect(p.choice.plan.network).toBe("ethereum");
    const row = await draftMove(w.db, { safeId, safeAddress: SAFE, plan: p, now: new Date(clock), wallet: MOCK_OWNER, destination: dest });
    const sent = await sendMove(ctx, row.id, deps);
    expect(sent.receipt).toContain("step 1 of 2");
    const [prop] = await w.db.select().from(proposals).where(eq(proposals.id, sent.proposalId));
    mockConfirm(w.services, 8453, prop.safeTxHash as Hex, MOCK_COSIGNER);
    await mockExecute(w.services, 8453, prop.safeTxHash as Hex);
    await followOpenProposals(w.db, w.services);
    await tick();
    const moved = await getMove(w.db, safeId, row.id);
    expect(moved.status).toBe("bridging");
    // The funds left Base in the fixture chain.
    const left = (await w.services.reader.readBalances(8453, SAFE)).balances.find((b) => b.symbol === "ETH")!.amount;
    expect(left).toBeLessThan(2.5);
    agg.statuses.set(moved.sourceTxHash!.toLowerCase(), { ...statusOf("done"), receiving: { ...statusOf("done").receiving!, amount: p.quote!.toAmountMin } });
    dest.payments.set(DEST_TX, p.quote!.toAmountMin);
    clock += 8 * MIN;
    await tick();
    const arrived = (await thread()).find((m) => m.id === `move-arrived-${row.id}`)!;
    expect((arrived.parts[0] as { text: string }).text).toContain("Step 2 of 2: sign the loan below.");
    expect(arrived.parts.some((x) => x.type === "data-block")).toBe(true);
    expect(await status(row.id)).toBe("arrived");
  });

  it("the default loan draft is a plan block on Base, and nothing for a network we cannot quote", async () => {
    const c = { db: w.db, services: w.services, safeId, safeAddress: SAFE };
    const then = { kind: "open" as const, venueId: "aave-v3", asset: "ETH" as const, amount: 1, borrow: 1000, safeId: "s", network: "base" as const };
    expect(await planBlockDraft(c, { then, arrivedUnits: 1, messageId: "m" })).toEqual([{ type: "data-block", data: { block: { kind: "plan", cash: 1000, asset: "ETH", network: "base", venueId: "aave-v3" } } }]);
    expect(await planBlockDraft(c, { then: { ...then, network: "ethereum" }, arrivedUnits: 1, messageId: "m" })).toEqual([]);
  });
});
