// Owners sign and execute a queued proposal from the app (docs/ux-visual/safe-sign-technical.md).
// Everything is rebuilt from the stored transaction; the client only sends its signature or a tx hash.
// The server never holds an owner key: it verifies, relays to the Transaction Service, and packs calldata.
import { and, eq } from "drizzle-orm";
import { getAddress, hashDomain, hashStruct, isHex, recoverAddress, slice, type Hex } from "viem";
import { proposals } from "@/server/db/schema";
import { requireNetwork } from "@/server/auth/access";
import { HttpError } from "@/server/http";
import { getMoveDeps } from "@/server/moves/deps";
import { gateMoveDelivery, type MoveGate } from "@/server/moves/gate";
import type { SafeContext } from "@/server/request";
import { networkFee } from "@/server/simulate/fee";
import { execCalldata, execCalldataMatches } from "@/server/safe/exec";
import { SAFE_TX_TYPES, safeTxHash as computeSafeTxHash, safeTxTypedData } from "@/server/safe/hash";
import { isOwnerEcdsaSignature, isPreValidatedFor, packSignatures, preValidatedSignature, recoverSafeSignature } from "@/server/safe/signature";
import { SafeServiceError, type Confirmation } from "@/server/safe/service-client";
import { SignerRefusal, loadOwnerSignable } from "@/server/signer/stored";
import type { Address, ChainId, SafeTx } from "@/shared/types";
import { chainExecDeps, mockExecDeps, type ExecDeps } from "./exec-deps";
import { refreshProposal } from "./follow";
import type { PendingExec } from "./pending";
import { viewOfRow } from "./read";
import { repayEligibility, type StoredRepaySpec } from "./repay";
import type { ProposalRow, ProposalView } from "./view";

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();
const execDepsOf = (ctx: SafeContext): ExecDeps => ctx.services.execDeps ?? (ctx.services.mock ? mockExecDeps : chainExecDeps);

export type Refusal = { code: "not_owner" | "already_signed" | "final" | "out_of_date" | "hash_mismatch" | "blocked"; message: string; /** The wallet must not be asked to sign. */ blocksSigning: boolean };
export type Blocker = { id: string | null; nonce: string; title: string | null };

async function loadRow(ctx: SafeContext, id: string): Promise<ProposalRow> {
  const [row] = await ctx.db.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.safeId, ctx.safe.id))).limit(1);
  if (!row) throw new HttpError(404, "Proposal not found");
  return row;
}

/** Live facts every owner route needs. Owners and nonce are read from chain now, never from the DB or the access cache. */
async function chainNow(ctx: SafeContext, row: ProposalRow) {
  const chainId = row.chainId as ChainId;
  const safe = getAddress(ctx.safe.address) as Address;
  const [owners, nonce, threshold] = await Promise.all([
    ctx.services.reader.readSafeOwners(chainId, safe).catch(() => null),
    ctx.services.reader.readSafeNonce(chainId, safe).catch(() => null),
    ctx.services.reader.readSafeThreshold(chainId, safe).catch(() => null),
  ]);
  if (!owners || nonce === null) throw new HttpError(503, "Could not read the Safe from the network right now. Try again in a moment.");
  return { chainId, safe, owners, nonce, threshold: threshold ?? row.threshold ?? owners.length, isOwner: owners.some((o) => lc(o) === lc(ctx.wallet)) };
}

/** Confirmations from the Transaction Service; the stored ones when it cannot be reached. */
async function liveConfirmations(ctx: SafeContext, row: ProposalRow): Promise<(Confirmation | { owner: string; submissionDate: string; signature?: undefined })[]> {
  try {
    const stx = await ctx.services.safeService(row.chainId as ChainId).getMultisigTransaction(row.safeTxHash as Hex);
    if (stx) return stx.confirmations;
  } catch { /* fall back to what we stored */ }
  return row.confirmations.map((c) => ({ owner: c.owner, submissionDate: c.submittedAt }));
}

async function blockersOf(ctx: SafeContext, row: ProposalRow, chainNonce: bigint): Promise<Blocker[]> {
  if (row.nonce === null || chainNonce >= row.nonce) return [];
  const ours = await ctx.db.select({ id: proposals.id, nonce: proposals.nonce, title: proposals.title }).from(proposals)
    .where(and(eq(proposals.safeId, ctx.safe.id), eq(proposals.chainId, row.chainId)));
  const open = ours.filter((p) => p.nonce !== null && p.nonce >= chainNonce && p.nonce < row.nonce! && p.id !== row.id);
  const out: Blocker[] = [];
  for (let n = chainNonce; n < row.nonce; n++) {
    const mine = open.find((p) => p.nonce === n);
    out.push({ id: mine?.id ?? null, nonce: n.toString(), title: mine?.title ?? null });
  }
  return out;
}

const stageRefusal = (stage: string): Refusal | null =>
  stage === "queued" ? null
    : { code: "final", blocksSigning: true, message: stage === "stale" ? "This proposal is out of date." : `This proposal is ${stage}; it cannot be signed.` };

/** Refuse unsafe queued moves while preserving the proposal and its reserved nonce. */
async function assertQueuedMoveDeliverable(ctx: SafeContext, row: ProposalRow, safe: Address): Promise<void> {
  if (row.stage !== "queued" || (row.spec as { kind?: string } | null)?.kind !== "move") return;
  let gate: MoveGate;
  try {
    gate = await gateMoveDelivery(ctx.db, getMoveDeps(ctx.services), row, safe);
  } catch {
    throw new HttpError(409, "The queued move could not be verified. Review the proposal before signing or sending.");
  }
  if (!gate.ok) throw new HttpError(409, `This queued move is blocked. ${gate.reason}`);
}

/** A queued partial repayment must still fit both the selected lender debt and Safe USDC. */
async function queuedRepayBlock(ctx: SafeContext, row: ProposalRow, safe: Address): Promise<string | null> {
  if (row.stage !== "queued" || (row.spec as { kind?: string } | null)?.kind !== "repay") return null;
  const check = await repayEligibility(ctx.services, row.chainId as ChainId, safe, row.spec as StoredRepaySpec);
  return check.ok ? null : check.reason;
}

/** The facts a wallet screen will show, so the person can compare. */
function plainFields(chainId: ChainId, safe: Address, tx: SafeTx) {
  return {
    safe, chainId, to: getAddress(tx.to), value: tx.value, operation: tx.operation, nonce: tx.nonce,
    dataSelector: tx.data.length >= 10 ? slice(tx.data, 0, 4) : null,
    dataBytes: (tx.data.length - 2) / 2,
  };
}

// ---- GET sign-data ----
export async function getSignData(ctx: SafeContext, id: string) {
  const row = await loadRow(ctx, id);
  requireNetwork(ctx.access, row.chainId as ChainId);
  const chain = await chainNow(ctx, row);
  if (!chain.isOwner) throw new HttpError(403, "You are not an owner of this Safe on this network");
  if (!row.tx) throw new HttpError(409, "This proposal has no transaction stored yet.");
  const tx = row.tx as SafeTx;
  const typed = safeTxTypedData(chain.chainId, chain.safe, tx);
  const hash = computeSafeTxHash(chain.chainId, chain.safe, tx);
  const reasons: Refusal[] = [];
  const stage = stageRefusal(row.stage);
  if (stage) reasons.push(stage);
  if (row.safeTxHash && lc(row.safeTxHash) !== lc(hash)) reasons.push({ code: "hash_mismatch", blocksSigning: true, message: "The stored transaction does not match its stored hash. Do not sign." });
  const confirmations = row.stage === "queued" ? await liveConfirmations(ctx, row) : [];
  if (confirmations.some((c) => lc(c.owner) === lc(ctx.wallet))) reasons.push({ code: "already_signed", blocksSigning: true, message: "You already signed this." });
  if (row.stage === "queued" && row.nonce !== null && chain.nonce > row.nonce) reasons.push({ code: "out_of_date", blocksSigning: true, message: "The Safe has moved past this transaction's nonce; it can no longer run." });
  const repayBlock = await queuedRepayBlock(ctx, row, chain.safe);
  if (repayBlock) reasons.push({ code: "out_of_date", blocksSigning: true, message: repayBlock });
  const blockedBy = row.stage === "queued" ? await blockersOf(ctx, row, chain.nonce) : [];
  if (blockedBy.length) reasons.push({ code: "blocked", blocksSigning: false, message: `It cannot run until ${blockedBy.length === 1 ? "an earlier transaction" : `${blockedBy.length} earlier transactions`} (nonce ${blockedBy.map((b) => b.nonce).join(", ")}) run.` });
  await assertQueuedMoveDeliverable(ctx, row, chain.safe);
  const jsonMessage = Object.fromEntries(Object.entries(typed.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return {
    typedData: { domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: jsonMessage },
    safeTxHash: hash,
    domainHash: hashDomain({ domain: typed.domain as never, types: { EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } }),
    messageHash: hashStruct({ data: typed.message, primaryType: "SafeTx", types: SAFE_TX_TYPES }),
    fields: plainFields(chain.chainId, chain.safe, tx),
    owners: chain.owners,
    threshold: chain.threshold,
    signedBy: confirmations.map((c) => getAddress(c.owner)),
    canSign: !reasons.some((r) => r.blocksSigning),
    reasons,
    blockedBy,
  };
}

// ---- POST confirm ----
export async function confirmProposal(ctx: SafeContext, id: string, signature: unknown): Promise<ProposalView> {
  const row0 = await loadRow(ctx, id);
  const chainId = row0.chainId as ChainId;
  const safe = getAddress(ctx.safe.address) as Address;
  if (typeof signature !== "string" || !isOwnerEcdsaSignature(signature)) throw new HttpError(400, "That is not a valid signature (expected 65 bytes with v 27 or 28).");
  let loaded;
  try {
    loaded = await loadOwnerSignable(ctx.db, { proposalId: id, chainId, safe });
  } catch (e) {
    if (e instanceof SignerRefusal) throw new HttpError(409, e.message);
    throw e;
  }
  const { safeTxHash: hash, tx, row } = loaded;
  let signer: Address;
  try {
    signer = await recoverAddress({ hash, signature });
  } catch {
    throw new HttpError(400, "That signature could not be read.");
  }
  if (lc(signer) !== lc(ctx.wallet)) throw new HttpError(403, "This signature is not from the wallet you are signed in with, or it signs something other than this proposal.");
  const chain = await chainNow(ctx, row);
  if (!chain.isOwner) throw new HttpError(403, "This wallet is not an owner of this Safe on this network.");
  if (row.nonce !== null && chain.nonce > row.nonce) throw new HttpError(409, "The Safe has moved past this transaction's nonce; it can no longer run.");
  const repayBlock = await queuedRepayBlock(ctx, row, safe);
  if (repayBlock) throw new HttpError(409, repayBlock);
  void tx;
  // Same owner twice is a no-op.
  const existing = await liveConfirmations(ctx, row);
  await assertQueuedMoveDeliverable(ctx, row, safe);
  if (!existing.some((c) => lc(c.owner) === lc(signer))) {
    try {
      await ctx.services.safeService(chainId).confirmTransaction({ safeTxHash: hash, signature });
    } catch (e) {
      if (e instanceof SafeServiceError) {
        if (e.status === 404) throw new HttpError(409, "This proposal is no longer in the Safe queue.");
        throw new HttpError(502, "Safe did not accept the signature. Try again in a moment.");
      }
      throw e;
    }
  }
  try { await refreshProposal(ctx.db, ctx.services, id); } catch { /* the worker repeats it */ }
  return viewOfRow(ctx, await loadRow(ctx, id));
}

// ---- GET execute-data ----
export type ExecNeeds = "ok" | "blocked" | "underSigned" | "outdated" | "refused" | "simulation_failed";

export async function getExecuteData(ctx: SafeContext, id: string) {
  const row = await loadRow(ctx, id);
  const chain = await chainNow(ctx, row);
  if (!chain.isOwner) throw new HttpError(403, "Only an owner of this Safe can send it.");
  const base = { to: chain.safe, chainId: chain.chainId, safeTxHash: row.tx ? computeSafeTxHash(chain.chainId, chain.safe, row.tx as SafeTx) : null };
  const none = { data: null, signatures: null, gas: null, gasLimit: null, fee: null, simulation: null, blockedBy: [] as Blocker[], includesYourApproval: false };
  const no = (needs: ExecNeeds, reason: string, extra: Partial<typeof none> & { nonce?: unknown } = {}) =>
    ({ ready: false, needs, reason, ...base, ...none, nonce: { chain: chain.nonce.toString(), tx: row.nonce?.toString() ?? null }, ...extra });

  if (!row.tx || !row.safeTxHash) return no("refused", "This proposal has no transaction stored yet.");
  const tx = row.tx as SafeTx;
  const hash = base.safeTxHash!;
  if (lc(row.safeTxHash) !== lc(hash)) return no("refused", "The stored transaction does not match its stored hash. Do not send it.");
  if (row.stage !== "queued") return no("refused", `This proposal is ${row.stage}; it cannot be sent.`);
  if ([tx.safeTxGas, tx.baseGas, tx.gasPrice].some((v) => BigInt(v) !== 0n) || lc(tx.gasToken) !== ZERO || lc(tx.refundReceiver) !== ZERO) {
    return no("refused", "This transaction has gas refund fields set; the app does not send those.");
  }
  if (chain.nonce > BigInt(tx.nonce)) return no("outdated", "The Safe has moved past this transaction's nonce; it can no longer run.");
  if (chain.nonce < BigInt(tx.nonce)) {
    const blockedBy = await blockersOf(ctx, row, chain.nonce);
    return no("blocked", `It cannot run until the earlier transaction${blockedBy.length === 1 ? "" : "s"} with nonce ${blockedBy.map((b) => b.nonce).join(", ")} run${blockedBy.length === 1 ? "s" : ""}.`, { blockedBy });
  }

  // Check the move before building and simulating execution calldata.
  await assertQueuedMoveDeliverable(ctx, row, chain.safe);
  const repayBlock = await queuedRepayBlock(ctx, row, chain.safe);
  if (repayBlock) return no("refused", repayBlock);

  // Valid owner signatures only: re-verified against the recomputed hash and the current owner set.
  const confirmations = await liveConfirmations(ctx, row);
  const entries = new Map<string, { owner: Address; signature: Hex }>();
  for (const c of confirmations) {
    const owner = chain.owners.find((o) => lc(o) === lc(c.owner));
    if (!owner) continue;
    const sig = c.signature;
    if (!sig) { // an on-chain approval the service indexed without a body
      entries.set(lc(owner), { owner, signature: preValidatedSignature(owner) });
    } else if (isPreValidatedFor(sig, owner)) {
      entries.set(lc(owner), { owner, signature: sig });
    } else {
      const who = await recoverSafeSignature(hash, sig);
      if (who && lc(who) === lc(owner)) entries.set(lc(owner), { owner, signature: sig });
    }
  }
  // Your own v=1 entry (you are the sender) may only complete a set that already has threshold-1 other valid owner approvals.
  // With a threshold of 1 there is nothing to complete: the sender must sign the typed data like anyone else.
  let includesYourApproval = false;
  if (!entries.has(lc(ctx.wallet)) && chain.threshold >= 2 && entries.size === chain.threshold - 1) {
    entries.set(lc(ctx.wallet), { owner: getAddress(ctx.wallet) as Address, signature: preValidatedSignature(ctx.wallet) });
    includesYourApproval = true;
  }
  if (entries.size < chain.threshold) {
    const yours = entries.has(lc(ctx.wallet));
    return no("underSigned", chain.threshold === 1 && !yours
      ? "It needs your signature first. Sign it, then send."
      : `It needs ${chain.threshold} signatures and has ${entries.size}.`);
  }
  // exactly `threshold` entries (with your v=1 entry the set is already exactly that size)
  const chosen = [...entries.values()].slice(0, chain.threshold);
  const signatures = packSignatures(chosen);
  const data = execCalldata(tx, signatures);

  const deps = execDepsOf(ctx);
  const sim = await deps.estimate({ chainId: chain.chainId, from: getAddress(ctx.wallet) as Address, to: chain.safe, data });
  if (!sim.ok) {
    return no("simulation_failed", `It would not go through right now: ${sim.error}`, { data, signatures, includesYourApproval, simulation: { ok: false, error: sim.error } } as never);
  }
  // Estimation may take long enough for an outside payment or Safe transfer to change the bounds.
  const finalRepayBlock = await queuedRepayBlock(ctx, row, chain.safe);
  if (finalRepayBlock) return no("refused", finalRepayBlock);
  const gasLimit = (sim.gas * 120n) / 100n;
  let fee: { eth: string; usd: number | null } | null = null;
  try {
    const gasPrice = await deps.gasPrice(chain.chainId);
    const price = await ctx.services.reader.readPrices(chain.chainId).then((p) => p.prices.ETH ?? p.prices.WETH ?? null).catch(() => null);
    fee = networkFee(sim.gas, gasPrice, price); // the estimated use, as the plan prices it; the 1.2x limit is a cap, not a cost
  } catch { /* the fee line is optional */ }
  return {
    ready: true, needs: "ok" as ExecNeeds, reason: null, ...base, data, signatures, gas: sim.gas.toString(), gasLimit: gasLimit.toString(), fee,
    simulation: { ok: true }, blockedBy: [] as Blocker[], includesYourApproval, nonce: { chain: chain.nonce.toString(), tx: tx.nonce },
  };
}

// ---- POST executed ----
export async function recordExecuted(ctx: SafeContext, id: string, txHash: unknown): Promise<ProposalView> {
  if (typeof txHash !== "string" || !isHex(txHash) || txHash.length !== 66) throw new HttpError(400, "That is not a transaction hash.");
  const row = await loadRow(ctx, id);
  const chain = await chainNow(ctx, row);
  if (!chain.isOwner) throw new HttpError(403, "Only an owner of this Safe can send it.");
  if (row.stage === "executed" || row.stage === "failed") return viewOfRow(ctx, row);
  if (row.stage !== "queued" || !row.tx) throw new HttpError(409, `This proposal is ${row.stage}.`);
  // The hash is a hint, never proof: if the node knows it, it must be this Safe's execution of this transaction.
  const seen = await execDepsOf(ctx).getTransaction(chain.chainId, txHash as Hex).catch(() => null);
  if (seen && (!seen.to || lc(seen.to) !== lc(chain.safe) || !execCalldataMatches(seen.input, row.tx as SafeTx))) {
    throw new HttpError(400, "That transaction is not an execution of this proposal.");
  }
  const marker: PendingExec = { txHash: txHash as Hex, at: new Date().toISOString(), by: lc(ctx.wallet), known: !!seen };
  await ctx.db.update(proposals).set({ testRun: { ...((row.testRun ?? {}) as Record<string, unknown>), pendingExec: marker }, updatedAt: new Date() })
    .where(and(eq(proposals.id, id), eq(proposals.stage, "queued")));
  try { await refreshProposal(ctx.db, ctx.services, id); } catch { /* the worker repeats it */ }
  return viewOfRow(ctx, await loadRow(ctx, id));
}
