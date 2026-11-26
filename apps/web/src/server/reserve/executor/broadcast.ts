// Preparation and submission share the reserve link lock. The signed bytes and deterministic hash
// commit before submission, and receipt waiting happens outside both transactions.
import { and, eq, lte, ne, sql } from "drizzle-orm";
import { DEFAULT_LEVELS, reserveTargetHf } from "@/lib/loan-math";
import type { Db } from "@/server/db/client";
import { loanLevels, reserveRuns, safes } from "@/server/db/schema";
import { sumUsd } from "@/server/loans";
import type { ChainReader } from "@/server/chain/reader";
import type { Address, ChainId } from "@/shared/types";
import type { Hex } from "viem";
import { allowanceNow } from "../allowance";
import type { ExecLink } from "../types";
import type { PreparedRepay } from "./chain";
import { planReserveRepay } from "./plan";
import type { ReserveRuntime } from "./runtime";
import { linkFingerprint, linkFromRow, releasedHandoffFields, unsignedClaimFields, withReserveLinkLock, type ReserveTx } from "./store";

/** A claimed (unsigned) run is live for this long; past it, recovery may take it over (a crashed claimer is replaced). */
export const HANDOFF_LEASE_MS = 120_000;
/** A claimed run older than this is failed instead of resumed — preparation can never silently churn forever. */
export const CLAIM_DEAD_MS = 30 * 60_000;
/** When recovery starts checking for a nonce that advanced without a matching receipt. */
export const NONCE_DEAD_GRACE_MS = 10 * 60_000;

export type ReserveRun = typeof reserveRuns.$inferSelect;

export type GateDeps = { db: Db; reader: ChainReader; now: Date };

/** What the locked gate decided. */
export type GateVerdict =
  /** The worker lost its claim or its unsigned run can no longer proceed. */
  | { kind: "skipped"; reason: "off" | "no-room" | "changed" }
  /** The run was marked failed inside the gate transaction; the caller reports it. */
  | { kind: "failed"; run: ReserveRun; error: string }
  /** The signed bytes and nonce are durable. Submission still requires authorized intent. */
  | { kind: "handoff"; link: ExecLink; run: ReserveRun; tx: PreparedRepay; balanceBeforeRaw: bigint };

type UnsignedClaim = ReserveRun & { leaseExpiresAt: Date };

export function isUnsignedClaim(run: ReserveRun): run is UnsignedClaim {
  return run.leaseExpiresAt !== null && run.signedTx === null && run.txHash === null
    && run.nonce === null && run.executorAddress === null && run.broadcastAt === null;
}

const claimMatches = (run: UnsignedClaim) => and(
  eq(reserveRuns.id, run.id), eq(reserveRuns.status, "pending"),
  eq(reserveRuns.leaseExpiresAt, run.leaseExpiresAt), unsignedClaimFields,
);

type Authorization =
  | { kind: "allowed"; balance: bigint }
  | { kind: "refused"; error: string }
  | { kind: "changed" };

async function authorizeRepay(reader: ChainReader, rt: Pick<ReserveRuntime, "chain">, link: ExecLink, run: ReserveRun, target: number): Promise<Authorization> {
  const read = await rt.chain.read(link);
  if (!read.executorIsMember) return { kind: "refused", error: "The reserve key is no longer a member of the on-chain role." };
  if (!read.policyAsDesigned) return { kind: "refused", error: "The on-chain module, scope, or limit does not match the reserve policy." };

  if (run.origin === "now") {
    const wallet = run.authorizedBy?.toLowerCase();
    const [mainOwners, reserveOwners] = await Promise.all([
      reader.readSafeOwners(link.chainId, link.mainSafe),
      reader.readSafeOwners(link.chainId, link.reserveSafe),
    ]);
    const owns = (owners: Address[] | null) => !!wallet && owners?.some((o) => o.toLowerCase() === wallet);
    if (!owns(mainOwners) || !owns(reserveOwners)) {
      return { kind: "refused", error: "The wallet that asked to use the reserve is no longer an owner of both Safes." };
    }
  }

  const { position } = await reader.readAavePosition(link.chainId, link.mainSafe);
  if (!position || position.id.toLowerCase() !== run.loanId || position.lender !== "aave-v3"
    || position.chainId !== link.chainId || position.collateral.length === 0 || position.debt.length !== 1
    || position.debt[0]!.asset !== link.tokenSymbol) return { kind: "changed" };
  // Use Aave's reported health factor to authorize an automatic repay. The estimate below sizes it.
  if (!Number.isFinite(position.healthFactor) || (run.origin !== "now" && !(position.healthFactor < link.trigger))) return { kind: "changed" };
  const collateralUsd = sumUsd(position.collateral);
  if (collateralUsd === null) return { kind: "changed" };

  const requested = BigInt(run.requestedRaw);
  const leftRaw = allowanceNow(read.allowance, read.nowSec).left;
  if (requested > leftRaw || requested > read.balance) return { kind: "changed" };
  const requestLimitRaw = leftRaw < read.balance ? leftRaw : read.balance;
  const scale = 10 ** link.tokenDecimals;
  const plan = planReserveRepay({
    collateralUsd, lt: position.liquidationThreshold, debt: position.debt[0]!.amount,
    trigger: run.origin === "now" ? Infinity : link.trigger, target,
    balance: Number(read.balance) / scale, allowanceLeft: Number(requestLimitRaw) / scale,
    decimals: link.tokenDecimals, allowanceLeftRaw: requestLimitRaw,
  });
  if (!plan || plan.requestRaw < requested) return { kind: "changed" };
  return { kind: "allowed", balance: read.balance };
}

/**
 * The bounded authorization/preparation gate for one claimed run. Everything that can make the repay wrong is
 * re-read under the link row lock; the last step commits the deterministic hash and the raw signed transaction
 * in the same transaction, so the same claim cannot be signed twice.
 * RPC reads inside (chain state, owners, position, signing) bound the lock to seconds — never a receipt wait.
 * Submission intent uses the same lock and repeats the authorization before making the send irrevocable.
 */
export async function gateHandoff(deps: GateDeps, rt: Pick<ReserveRuntime, "chain" | "signer">, run: ReserveRun, opts: { target: number }): Promise<GateVerdict> {
  const { db, reader, now } = deps;
  if (!isUnsignedClaim(run) || run.leaseExpiresAt <= now) return { kind: "skipped", reason: "no-room" };
  const claim = claimMatches(run);
  const chainId = run.chainId as ChainId;
  return withReserveLinkLock(db, run.safeId, chainId, async (tx, row) => {
    // Hold the exact claim through signing so lease renewal or expiry cannot commit during handoff.
    const [current] = await tx.select({ id: reserveRuns.id }).from(reserveRuns).where(claim).for("update");
    if (!current) return { kind: "skipped", reason: "no-room" };

    const drop = async (reason: "off" | "no-room" | "changed"): Promise<GateVerdict> => {
      await tx.delete(reserveRuns).where(claim);
      return { kind: "skipped", reason };
    };
    const refuse = async (error: string): Promise<GateVerdict> => {
      const [failed] = await tx.update(reserveRuns).set({ status: "failed", error }).where(claim).returning();
      return { kind: "failed", run: failed!, error };
    };

    // The server flag re-read under the lock: "off" (turned off) and "pending" (a re-link being set up) both stop a broadcast.
    if (!row || row.state !== "linked") return drop("off");
    // The link generation: the row's attempt and addresses re-read under the lock must be the generation the
    // run was claimed under. A re-link (attempt bump, new Roles proxy, new Reserve Safe, new executor key)
    // changes the fingerprint — a request prepared for an older link can never spend under a newer one.
    const [mains, reserves] = await Promise.all([
      tx.select({ address: safes.address }).from(safes).where(eq(safes.id, row.mainSafeId)).limit(1),
      tx.select({ address: safes.address }).from(safes).where(eq(safes.id, row.reserveSafeId)).limit(1),
    ]);
    const [main] = mains;
    const [reserve] = reserves;
    if (!main || !reserve) return refuse("The Safe rows behind the reserve link are gone.");
    const link = linkFromRow(run.safeId, chainId, row, main.address, reserve.address);
    if (run.linkFingerprint !== linkFingerprint(link)) {
      return refuse("The reserve was re-linked before the repay was broadcast; the request belonged to an older link.");
    }

    // One repay in flight per loan: any other pending run for it blocks this one.
    const [other] = await tx.select({ id: reserveRuns.id }).from(reserveRuns)
      .where(and(eq(reserveRuns.safeId, run.safeId), eq(reserveRuns.loanId, run.loanId), eq(reserveRuns.status, "pending"), ne(reserveRuns.id, run.id))).limit(1);
    if (other) return drop("no-room");

    const authorization = await authorizeRepay(reader, rt, link, run, opts.target);
    if (authorization.kind === "refused") return refuse(authorization.error);
    if (authorization.kind === "changed") return drop("changed");

    // The chain's pending nonce can advance before a receipt. Keep one unresolved reservation per
    // executor so a second reserve cannot sign a higher nonce before this run settles. A pending row
    // whose sender is unknown (a pre-upgrade run carries no executor; only the unsigned claim proves
    // nothing was sent) could belong to this executor, so it fences fresh allocations chain-wide.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`reserve-exec:${chainId}:${link.executor.toLowerCase()}`}, 0))`);
    // One statement, one snapshot: under Read Committed two reads could straddle a settlement —
    // a row seen pending in the first and done in the second. Blocking and the mined-nonce floor
    // are computed together, and the floor is `max(network pending, highest known mined + 1)`.
    const executor = link.executor.toLowerCase();
    const [fence] = await tx.select({
      blocking: sql<boolean>`coalesce(bool_or((${reserveRuns.status} = 'pending') and (${reserveRuns.executorAddress} = ${executor} or (${reserveRuns.executorAddress} is null and not ${unsignedClaimFields}))), false)`,
      minedNonce: sql<unknown>`max(${reserveRuns.nonce}) filter (where ${reserveRuns.status} in ('done', 'failed') and ${reserveRuns.txHash} is not null and ${reserveRuns.executorAddress} = ${executor})`.mapWith((v) => v === null || v === undefined ? null : Number(v)),
    }).from(reserveRuns).where(eq(reserveRuns.chainId, chainId));
    if (!fence || fence.blocking) return drop("no-room");
    const chainNonce = Math.max(await rt.chain.nonce(link), (fence.minedNonce ?? -1) + 1);

    // Sign for THIS generation under the allocated nonce. A role/allowance refusal is terminal; an RPC error
    // inside `prepare` throws, rolls the claim back, and recovery drives the same run again after the lease.
    const prep = await rt.chain.prepare(link, BigInt(run.requestedRaw), chainNonce, rt.signer);
    if (!prep.ok) return refuse(prep.error);

    // Keep the lease as a marker for a newly signed, never-submitted handoff. A separate transaction
    // commits submission intent before sending these bytes.
    try {
      const [handed] = await tx.update(reserveRuns).set({
        signedTx: prep.tx.raw, txHash: prep.tx.hash, nonce: prep.tx.nonce,
        executorAddress: link.executor.toLowerCase(), error: null,
      }).where(claim).returning();
      return { kind: "handoff", link, run: handed!, tx: prep.tx, balanceBeforeRaw: authorization.balance };
    } catch {
      // A Drizzle error can include all bind parameters, including the signed bytes.
      throw new Error(`Could not persist reserve handoff for run ${run.id} (${prep.tx.hash})`);
    }
  });
}

export type SubmitVerdict =
  | { kind: "submitted" }
  | { kind: "failed"; run: ReserveRun; error: string }
  | { kind: "settled" }
  | { kind: "unknown"; error: string };

/** Authorize and commit intent once, then relay the exact persisted bytes until settlement. */
export async function submitPreparedIfAuthorized(deps: GateDeps, rt: Pick<ReserveRuntime, "chain">, run: ReserveRun, tx: PreparedRepay): Promise<SubmitVerdict> {
  const { db, reader, now } = deps;
  const chainId = run.chainId as ChainId;
  const pending = and(eq(reserveRuns.id, run.id), eq(reserveRuns.status, "pending"));

  async function lockHandoff(t: ReserveTx) {
    const [current] = await t.select().from(reserveRuns).where(pending).for("update");
    const prepared = current && asPrepared(current);
    if (prepared?.raw === tx.raw && prepared.hash === tx.hash && prepared.nonce === tx.nonce) return current;
  }

  if (run.broadcastAt === null) {
    const denied = await withReserveLinkLock<SubmitVerdict | undefined>(db, run.safeId, chainId, async (t, row) => {
      const current = await lockHandoff(t);
      if (!current) return { kind: "settled" };
      if (current.broadcastAt !== null) return; // another worker already committed intent

      const refuse = async (error: string): Promise<SubmitVerdict> => {
        const [failed] = await t.update(reserveRuns).set({ ...releasedHandoffFields, error }).where(pending).returning();
        return { kind: "failed", run: failed!, error };
      };
      if (!row || row.state !== "linked") return refuse("The reserve is off or being re-linked.");
      const [mains, reserves] = await Promise.all([
        t.select({ address: safes.address }).from(safes).where(eq(safes.id, row.mainSafeId)).limit(1),
        t.select({ address: safes.address }).from(safes).where(eq(safes.id, row.reserveSafeId)).limit(1),
      ]);
      const [main] = mains;
      const [reserve] = reserves;
      const relinked = "The repay was prepared for an older reserve link.";
      if (!main || !reserve) return refuse(relinked);
      const link = linkFromRow(run.safeId, chainId, row, main.address, reserve.address);
      if (current.linkFingerprint !== linkFingerprint(link) || current.executorAddress !== link.executor.toLowerCase()) return refuse(relinked);

      const target = await gateTarget(t, run.safeId, current.loanId, link.trigger);
      const authorization = await authorizeRepay(reader, rt, link, current, target).catch(() => null);
      if (!authorization) return refuse("The current reserve authorization or loan could not be verified.");
      if (authorization.kind === "refused") return refuse(authorization.error);
      if (authorization.kind === "changed") return refuse("The current loan, allowance or balance no longer supports the prepared amount.");

      await t.update(reserveRuns).set({ broadcastAt: now, leaseExpiresAt: null }).where(pending);
    });
    if (denied) return denied;
  }

  // After intent, checking the current link or owner would strand the nonce on a policy change.
  // The row lock still fences settlement, and the link lock serializes the bounded RPC with turn-off.
  return withReserveLinkLock(db, run.safeId, chainId, async (t) => {
    const current = await lockHandoff(t);
    if (!current?.broadcastAt) return { kind: "settled" };
    try {
      await rt.chain.submit(chainId, tx);
      return { kind: "submitted" };
    } catch {
      // A provider error can include the raw RPC request. Keep only safe diagnostics.
      return { kind: "unknown", error: "The network did not confirm submission." };
    }
  });
}

/**
 * Take over a claimed run whose lease lapsed (its claimer crashed or stalled). Atomic: the update only lands
 * while the row is still an unsigned pending run past its lease, so two recoveries can never both resume it.
 */
export async function claimExpiredRun(db: Db, run: ReserveRun, now: Date): Promise<ReserveRun | undefined> {
  if (!isUnsignedClaim(run)) return;
  const [claimed] = await db.update(reserveRuns).set({ leaseExpiresAt: new Date(now.getTime() + HANDOFF_LEASE_MS) })
    .where(and(claimMatches(run), lte(reserveRuns.leaseExpiresAt, now))).returning();
  return claimed;
}

/** Time out only the same expired claim that the monitor observed. */
export async function failExpiredRun(db: Db, run: UnsignedClaim, now: Date, error: string): Promise<ReserveRun | undefined> {
  const [failed] = await db.update(reserveRuns).set({ status: "failed", error })
    .where(and(claimMatches(run), lte(reserveRuns.leaseExpiresAt, now))).returning();
  return failed;
}

/** The target the gate's re-plan aims for, from the loan's saved levels (the same value the pre-claim plan used). */
export async function gateTarget(db: Pick<Db, "select">, safeId: number, loanId: string, trigger: number): Promise<number> {
  const [level] = await db.select({ warn: loanLevels.warn }).from(loanLevels)
    .where(and(eq(loanLevels.safeId, safeId), eq(loanLevels.loanId, loanId.toLowerCase()))).limit(1);
  return reserveTargetHf({ ...DEFAULT_LEVELS, warn: level?.warn ?? DEFAULT_LEVELS.warn }, trigger);
}

export type { PreparedRepay };
export const asPrepared = (run: ReserveRun): PreparedRepay | null =>
  run.signedTx && run.txHash && run.nonce !== null && run.executorAddress && (run.broadcastAt || run.leaseExpiresAt) ? { raw: run.signedTx as Hex, hash: run.txHash as Hex, nonce: run.nonce } : null;
