// The deposit job (BP-31, architecture section 4): read the balances of every watched Safe on every
// network we track for it, store a deposit when one rises, and tell the user once: an Activity row
// (G3) and a chat message whose figures come from the app's own quote code (G1), never the model.
import { and, eq, gt, gte, isNotNull, isNull, like, lt } from "drizzle-orm";
import type { LanguageModel } from "ai";
import { depositLine } from "@/lib/blocks";
import { fmt, usd } from "@/lib/format";
import { MIN_LOAN } from "@/lib/loan-math";
import { shortAddress } from "@/lib/address";
import { recordActivity } from "@/server/activity";
import { runEventTurn } from "@/server/agent/event-turn";
import { getChatModel } from "@/server/agent/model";
import { appendServerMessage, type ChatMessage } from "@/server/agent/persist";
import type { Urgent } from "@/lib/blocks";
import { readBlockData } from "@/server/blocks/block-inputs";
import { urgentLoanOf } from "@/server/blocks/greeting";
import { AAVE } from "@/server/chain/config";
import { servedOnly } from "@/server/auth/access";
import type { ChainReader } from "@/server/chain/types";
import { schema, type Db } from "@/server/db/client";
import type { Services } from "@/server/services";
import type { Job } from "@/worker/jobs";
import type { Asset } from "@/lib/types";
import { messages as messagesTable } from "@/server/db/schema";
import { CHAIN_NAME, type Address, type ChainId, type Hex } from "@/shared/types";
import { attributeToMoves, type ArrivalProof } from "@/server/moves/attribution";
import { getMoveDeps } from "@/server/moves/deps";
import { detectRises } from "./detect";

type Cause = { id: string; /** Assets it moved to the Safe; null when its record does not say. */ assets: Set<string> | null };

/**
 * The assets an executed proposal sent to the Safe. A close names the collateral it takes back in its stored spec
 * (`collAsset`); otherwise the stored steps are read: a withdraw ("Withdraw 5 WETH", "Withdraw all WETH", "Take all
 * WETH back") returns collateral, a borrow pays out the borrowed asset. Repay and supply only move funds out.
 * Null for a kind or shape not known.
 */
export function assetsMovedIn(row: { spec: unknown; steps: string[] }): Set<string> | null {
  const kind = (row.spec as { kind?: string } | null)?.kind;
  if (kind !== "protect" && kind !== "open" && kind !== "close" && kind !== "move") return null;
  const assets = new Set<string>();
  const coll = (row.spec as { collAsset?: unknown }).collAsset;
  if (kind === "close" && typeof coll === "string" && coll) return new Set([coll]);
  for (const step of row.steps) {
    const m = /^(?:(?:Withdraw|Borrow) (?:all |[\d.,]+ )|Take (?:all |[\d.,]+ ))(\S+)/.exec(step);
    if (m) assets.add(m[1]);
  }
  if (kind === "close" && assets.size === 0) return null;
  return assets;
}

/**
 * Proposals that executed on this network since the previous poll: marked executed, or still marked queued
 * but already executed according to the Safe service (the follow job has not caught up). Read-only.
 */
async function executedCauses(ctx: Ctx, safeId: number, safeAddress: string, chainId: ChainId, since: Date): Promise<Cause[]> {
  const rows = await ctx.db.select().from(schema.proposals)
    .where(and(eq(schema.proposals.safeId, safeId), eq(schema.proposals.chainId, chainId), eq(schema.proposals.stage, "executed"), gt(schema.proposals.updatedAt, since)));
  const causes: Cause[] = rows.map((r) => ({ id: r.id, assets: assetsMovedIn(r) }));
  // The follower marks a proposal executed up to a poll later than the chain moves, so a "queued" one whose nonce the Safe has already passed counts too.
  const nonce = await ctx.reader.readSafeNonce(chainId, safeAddress as Address).catch(() => null);
  if (nonce !== null) {
    const passed = await ctx.db.select().from(schema.proposals)
      .where(and(eq(schema.proposals.safeId, safeId), eq(schema.proposals.chainId, chainId), eq(schema.proposals.stage, "queued"), lt(schema.proposals.nonce, nonce)));
    for (const r of passed) causes.push({ id: r.id, assets: assetsMovedIn(r) });
  }
  if (!ctx.services) return causes;
  const queued = await ctx.db.select().from(schema.proposals)
    .where(and(eq(schema.proposals.safeId, safeId), eq(schema.proposals.chainId, chainId), eq(schema.proposals.stage, "queued"), isNotNull(schema.proposals.safeTxHash)));
  for (const r of queued) {
    if (causes.some((c) => c.id === r.id)) continue;
    try {
      const tx = await ctx.services.safeService(chainId).getMultisigTransaction(r.safeTxHash as Hex);
      if (tx?.isExecuted && tx.isSuccessful !== false) causes.push({ id: r.id, assets: assetsMovedIn(r) });
    } catch (e) {
      ctx.log(`deposits: could not ask the Safe service about proposal ${r.id} on ${chainId}:${safeAddress}`, e);
    }
  }
  return causes;
}

/** Default poll interval: once a minute (the story's "within about 60 s"). One config value. */
export const DEPOSIT_POLL_MS = 60_000;
/** A rise worth less than this is dust (a stray wei), not a deposit. */
const DUST_USD = 0.5;
/** A Safe added this recently (or not deployed yet) has no silent baseline: its first balance is announced. */
export const NEW_SAFE_WINDOW_MS = 30 * 60_000;

const amountText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 0.01 ? 8 : 4 });

type Ctx = { db: Db; reader: ChainReader; services?: Services; /** How a pending move's arrival is proven (tests); default: the move deps of `services`. */ moveProof?: ArrivalProof; now: Date; log: (message: string, detail?: unknown) => void;
  /** The model for the agent turn that follows a deposit. Without it no turn runs and the fixed line stands alone. */
  chatModel?: (o: { maxCash: number; urgent?: Urgent }) => LanguageModel;
  /** How long after the job starts (real time) a new agent turn may still begin; later Safes' turns wait for the next run. Default TURN_PHASE_MS. */
  turnBudgetMs?: number };

/** Agent turns take up to 45 s each; none starts later than this after the job began, so the whole run stays inside the cron's 300 s. */
export const TURN_PHASE_MS = 120_000;

/** At most one agent turn per Safe in this window; deposits that land inside it are told by one later turn. */
export const DEPOSIT_TURN_GAP_MS = 2 * 60_000;
/** A deposit announced longer ago than this is not turned any more (a failed turn is retried only briefly). */
const TURN_RETRY_MS = 3 * 60_000;
export const turnId = (depositId: number) => `deposit-turn-${depositId}`;

/** The block numbers and prices of the read the deposit came from. */
async function pollNetwork(ctx: Ctx, safe: { id: number; address: string; createdAt: Date; deployed: boolean }, chainId: ChainId): Promise<void> {
  const { db, reader } = ctx;
  const read = await reader.readBalances(chainId, safe.address as Address);
  const stored = await db.select().from(schema.depositBalances).where(and(eq(schema.depositBalances.safeId, safe.id), eq(schema.depositBalances.chainId, chainId)));
  const isNew = !safe.deployed || ctx.now.getTime() - safe.createdAt.getTime() < NEW_SAFE_WINDOW_MS;
  let { rises, next } = detectRises(new Map(stored.map((r) => [r.asset, BigInt(r.raw)])), read.balances, isNew);
  if (rises.length && stored.length) {
    // The agent's own executed proposals (a withdraw, a close, a borrow paying out) move balances too. Only the
    // assets they moved to the Safe are skipped; a rise in any other asset is a deposit. When a proposal's assets
    // cannot be read, this network's rises are skipped for this poll.
    const prevPoll = new Date(Math.max(...stored.map((r) => r.updatedAt.getTime())));
    const causes = await executedCauses(ctx, safe.id, safe.address, chainId, prevPoll);
    const unknown = causes.find((c) => c.assets === null);
    if (unknown) {
      ctx.log(`deposits: executed proposal ${unknown.id} on ${chainId}:${safe.address} has assets I cannot read; rises skipped for this poll`, rises.map((r) => `${r.asset}:${r.raw}`));
      rises = [];
    } else {
      const moved = new Set(causes.flatMap((c) => [...c.assets!]));
      const skipped = rises.filter((r) => moved.has(r.asset));
      if (skipped.length) ctx.log(`deposits: rise on ${chainId}:${safe.address} explained by executed proposals ${causes.map((c) => c.id).join(", ")}; not a deposit`, skipped.map((r) => `${r.asset}:${r.raw}`));
      rises = rises.filter((r) => !moved.has(r.asset));
    }
  }
  // A move's arrival (or refund) is not a deposit: the part of the rise the asset's own move explains is skipped (E9).
  rises = await attributeToMoves(db, safe.id, chainId, rises, ctx.now, ctx.moveProof ?? (ctx.services ? getMoveDeps(ctx.services) : undefined), safe.address);
  const prices = rises.length ? (await reader.readPrices(chainId)).prices : {};
  await db.transaction(async (tx) => {
    for (const r of rises) {
      const amount = Number(r.raw) / 10 ** r.decimals;
      const valueUsd = amount * (prices[r.asset] ?? 0);
      if (valueUsd < DUST_USD) continue;
      await tx.insert(schema.deposits).values({ safeId: safe.id, chainId, asset: r.asset, raw: r.raw.toString(), amount: String(amount), valueUsd: String(valueUsd), blockNumber: read.blockNumber });
    }
    for (const [asset, raw] of next) {
      await tx.insert(schema.depositBalances).values({ safeId: safe.id, chainId, asset, raw: raw.toString(), blockNumber: read.blockNumber, updatedAt: ctx.now })
        .onConflictDoUpdate({ target: [schema.depositBalances.safeId, schema.depositBalances.chainId, schema.depositBalances.asset], set: { raw: raw.toString(), blockNumber: read.blockNumber, updatedAt: ctx.now } });
    }
  });
}

/** Activity row and chat message for one deposit; both are idempotent, so a retry after a crash writes each once. */
async function announce(ctx: Ctx, dep: typeof schema.deposits.$inferSelect, safe: { id: number; address: string; name: string }): Promise<void> {
  const { db, reader } = ctx;
  const chainId = dep.chainId as ChainId;
  const asset = dep.asset as Asset;
  const amount = Number(dep.amount);
  const value = Number(dep.valueUsd);
  const name = safe.name || shortAddress(safe.address);
  const network = CHAIN_NAME[chainId] ?? `chain ${chainId}`;

  const parts: ChatMessage["parts"] = [];
  if (AAVE[chainId]) {
    // The same live inputs and quote function as every other block (VC-02), at this deposit's network.
    const d = await readBlockData({
      services: { reader, lenders: ctx.services?.lenders } as never,
      safe: { id: safe.id, address: safe.address, name: safe.name } as never,
      networks: [],
      access: { ownedChainIds: [chainId] } as never,
    });
    const max = Math.floor(d.max);
    // No sentence or chip invites borrowing while a loan is at risk (VC-03).
    const urgent = await urgentLoanOf(d, { db, safe: { id: safe.id } as never });
    parts.push({ type: "text", text: depositLine(name, network, asset, Number(amountText(amount).replace(/,/g, "")), value, max, !!urgent) });
    if (max >= MIN_LOAN && !urgent) parts.push({ type: "data-block", data: { block: { kind: "suggestions", items: [`Borrow ${usd(max)}`] } } });
  } else {
    parts.push({ type: "text", text: `I see ${amountText(amount)} ${asset} (about ${usd(value)}) on ${network} in ${name}. I can't lend on ${network} yet.` });
  }

  await recordActivity(db, {
    safeId: safe.id, chainId, actor: "Agent", kind: "status", eventKey: `deposit:${dep.id}`, at: ctx.now,
    text: `Saw a deposit of ${amountText(amount)} ${asset} (about ${usd(value)}) on ${network}.`,
    detail: `Balance rose at block ${dep.blockNumber}.`,
  });
  await appendServerMessage(db, safe.id, { id: `deposit-${dep.id}`, parts, now: ctx.now, fact: { kind: "deposit", amount, asset, network, valueUsd: value, blockNumber: String(dep.blockNumber) } });
  await db.update(schema.deposits).set({ announcedAt: ctx.now }).where(eq(schema.deposits.id, dep.id));
}

/**
 * One agent turn for a Safe's announced deposits that no turn has covered yet. A turn stored as `deposit-turn-<id>` covers
 * every deposit of the Safe up to that id, so a retry or a later run adds nothing. Never throws: on a failure the fixed line stays.
 */
async function agentTurn(ctx: Ctx, safe: { id: number; address: string; name: string }): Promise<void> {
  const { db, reader } = ctx;
  if (!ctx.chatModel) return;
  const stored = await db.select({ id: messagesTable.id, createdAt: messagesTable.createdAt }).from(messagesTable).where(and(eq(messagesTable.safeId, safe.id), like(messagesTable.id, "deposit-turn-%")));
  const covered = Math.max(0, ...stored.map((r) => Number(r.id.slice("deposit-turn-".length)) || 0));
  const fresh = new Date(ctx.now.getTime() - TURN_RETRY_MS);
  const todo = (await db.select().from(schema.deposits).where(and(eq(schema.deposits.safeId, safe.id), isNotNull(schema.deposits.announcedAt), gte(schema.deposits.announcedAt, fresh))))
    .filter((d) => d.id > covered && AAVE[d.chainId as ChainId]).sort((a, b) => a.id - b.id);
  if (!todo.length) return;
  // The gap runs from when the last turn actually ran (its message's time, set to the job's clock below), not from its deposit's announcement.
  const lastTurnAt = Math.max(0, ...stored.map((r) => r.createdAt.getTime()));
  if (lastTurnAt > 0 && ctx.now.getTime() - lastTurnAt < DEPOSIT_TURN_GAP_MS) return;
  try {
    const d = await readBlockData({ services: { reader, lenders: ctx.services?.lenders } as never, safe: { id: safe.id, address: safe.address, name: safe.name } as never, networks: [], access: { ownedChainIds: [...new Set(todo.map((x) => x.chainId as ChainId))] } as never });
    const urgent = await urgentLoanOf(d, { db, safe: { id: safe.id } as never });
    const max = Math.floor(d.max);
    const what = todo.map((x) => `${fmt(Number(x.amount), 2)} ${x.asset} on ${CHAIN_NAME[x.chainId as ChainId] ?? `chain ${x.chainId}`}`).join(", ");
    const event = `Event: ${todo.length > 1 ? "deposits" : "a deposit"} of ${what} arrived in ${safe.name || shortAddress(safe.address)}; new holdings attached below. `
      + `The factual deposit line was already posted, so do not repeat it. Reply with one short sentence and exactly one tool: `
      + (urgent ? "a loan needs attention first, so offer no borrowing and call showStatus. " : max >= MIN_LOAN ? "the Safe can now borrow past the minimum loan, so call planLoan or showHoldings. " : "the Safe is still below the minimum loan, so call showHoldings and say what the owner can do (send more). ")
      + `Never write an amount, rate or price in text; the card shows them. (Context only, do not quote: it can borrow up to ${max} dollars now; the minimum loan is ${MIN_LOAN} dollars.)`;
    await runEventTurn({ db, safeId: safe.id, model: ctx.chatModel({ maxCash: max, urgent: urgent ?? undefined }), event, id: turnId(todo[todo.length - 1].id) });
    await db.update(messagesTable).set({ createdAt: ctx.now }).where(eq(messagesTable.id, turnId(todo[todo.length - 1].id)));
  } catch (e) {
    ctx.log(`deposits: agent turn for safe ${safe.id} failed; the fixed deposit line stands`, e);
  }
}

export async function pollDeposits(ctx: Ctx): Promise<void> {
  const { db } = ctx;
  const startedAt = Date.now();
  const rows = await db
    .select({ id: schema.safes.id, address: schema.safes.address, name: schema.safes.name, createdAt: schema.safes.createdAt, deployed: schema.safeNetworks.deployed, chainId: schema.safeNetworks.chainId })
    .from(schema.safeNetworks)
    .innerJoin(schema.safes, eq(schema.safes.id, schema.safeNetworks.safeId))
    .then((all) => all.filter((r) => servedOnly([r.chainId]).length > 0)); // creation networks without a reader are not polled
  const failures: string[] = [];
  const fail = (what: string, e: unknown) => {
    ctx.log(`deposits: ${what} failed`, e);
    failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  };
  for (const r of rows) {
    try {
      await pollNetwork(ctx, r, r.chainId as ChainId);
    } catch (e) {
      fail(`${r.chainId}:${r.address}`, e);
    }
  }
  // Announce after reading, so a deposit stored by an earlier crashed tick is also told, once.
  const pending = await db.select().from(schema.deposits).where(isNull(schema.deposits.announcedAt));
  const safes = new Map(rows.map((r) => [r.id, r]));
  for (const dep of pending) {
    const safe = safes.get(dep.safeId);
    if (!safe) continue;
    try {
      await announce(ctx, dep, safe);
    } catch (e) {
      fail(`announce deposit ${dep.id}`, e);
    }
  }
  // After every deposit is announced: one agent turn per Safe that has deposits no turn has covered yet.
  // Turns are sequential and slow, so past the budget the rest wait: their deposits stay uncovered and the next run (inside TURN_RETRY_MS) takes them.
  for (const safe of new Map(rows.map((r) => [r.id, r])).values()) {
    if (Date.now() - startedAt >= (ctx.turnBudgetMs ?? TURN_PHASE_MS)) {
      ctx.log("deposits: agent-turn time budget used; the remaining Safes' turns wait for the next run");
      break;
    }
    try {
      await agentTurn(ctx, safe);
    } catch (e) {
      ctx.log(`deposits: agent turn for safe ${safe.id} failed`, e);
    }
  }
  // One failure does not stop the others, but the tick still records as failed.
  if (failures.length) throw new Error(failures.join("; "));
}

export const depositJob: Job = {
  name: "deposits",
  intervalMs: Number(process.env.DEPOSIT_POLL_MS) || DEPOSIT_POLL_MS,
  async run({ db, reader, services, now, log }) {
    await pollDeposits({ db, reader, services, now, log, chatModel: (o) => getChatModel(o) });
  },
};
