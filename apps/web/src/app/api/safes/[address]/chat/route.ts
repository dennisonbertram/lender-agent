import { and, desc, eq, inArray } from "drizzle-orm";
import { proposals } from "@/server/db/schema";
import { NextResponse } from "next/server";
import { requireChat } from "@/server/auth/access";
import { getChatModel } from "@/server/agent/model";
import { loadThread } from "@/server/agent/persist";
import { planCheckFor } from "@/server/plan-check";
import type { PlanCheck } from "@/server/agent/tools";
import { loansNote } from "@/server/agent/context";
import { runChat } from "@/server/agent/run";
import { readBlockData, servedOwned } from "@/server/blocks/block-inputs";
import { loanStandingOf, urgentLoanOf } from "@/server/blocks/greeting";
import { HttpError, toResponse } from "@/server/http";
import { borrowLimit, liveInputs, openLoansOf, unreadLenders } from "@/server/market-inputs";
import { MIN_LOAN } from "@/lib/loan-math";
import type { Loan } from "@/lib/types";
import type { LoanStanding } from "@/lib/intents";
import type { Urgent } from "@/lib/blocks";
import { safeContext, type SafeContext } from "@/server/request";
import type { Address, ChainId } from "@/shared/types";

export const dynamic = "force-dynamic";

const agentOnAnywhere = (ctx: SafeContext) => ctx.networks.some((n) => n.agentAdded);

type Reads = { max: number; planCheck?: PlanCheck; loans: ReturnType<typeof openLoansOf>; unread: string[]; loansUnknown: boolean };

/** The most this Safe can safely borrow now, for routing (0 when the first read fails: routing then asks for funds), and the open loans on every owned served network. A failed read leaves the loans unknown, never "none". */
async function readSafe(ctx: SafeContext): Promise<Reads> {
  const chains = servedOwned(ctx);
  const read = (id: ChainId) => liveInputs(ctx.services.reader, id, ctx.safe.address as Address, ctx.services.lenders);
  const results = await Promise.allSettled(chains.map(read));
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const first = ok.find((i) => borrowLimit(i).max >= MIN_LOAN) ?? ok[0];
  const open = await ctx.db.select({ chainId: proposals.chainId, spec: proposals.spec }).from(proposals)
    .where(and(eq(proposals.safeId, ctx.safe.id), inArray(proposals.stage, ["queued", "sending"]))).orderBy(desc(proposals.createdAt));
  const editNetwork = open.find((p) => typeof p.spec === "object" && p.spec !== null && "kind" in p.spec && p.spec.kind === "open" && servedOwned(ctx).includes(p.chainId as ChainId))?.spec as { kind?: string; network?: string } | undefined;
  return {
    max: first ? borrowLimit(first).max : 0,
    planCheck: ok.length ? planCheckFor(read, ok, servedOwned(ctx), editNetwork?.network) : undefined,
    loans: openLoansOf(ok),
    unread: unreadLenders(ok),
    loansUnknown: results.length === 0 || ok.length < results.length,
  };
}

/** The first loan at risk, if any (so the fallback and scripted replies offer no Borrow chip, VC-03), and where the loans stand overall. One read. */
async function loanFacts(ctx: SafeContext): Promise<{ urgent?: Urgent; standing: LoanStanding }> {
  try {
    const d = await readBlockData(ctx);
    return { urgent: await urgentLoanOf(d, ctx), standing: await loanStandingOf(d, ctx) };
  } catch {
    return { standing: { status: "unknown" } };
  }
}

/** A proposal of this Safe is waiting for signatures (queued), so "Send replaces it" is true. */
async function hasOpenProposal(ctx: SafeContext): Promise<boolean> {
  try {
    const rows = await ctx.db.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.safeId, ctx.safe.id), inArray(proposals.stage, ["queued", "sending"]))).limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** The stored thread, in order. */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const ctx = await safeContext(req, address);
    requireChat(ctx.access);
    return NextResponse.json({ messages: await loadThread(ctx.db, ctx.safe.id) });
  } catch (err) {
    return toResponse(err);
  }
}

/** Send a message (the AI SDK chat request) and stream the reply. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const ctx = await safeContext(req, address);
    requireChat(ctx.access);
    if (!agentOnAnywhere(ctx)) throw new HttpError(409, "The Lender agent is not on this Safe.");
    const body = (await req.json().catch(() => null)) as { messages?: unknown } | null;
    if (!body || !Array.isArray(body.messages)) throw new HttpError(400, "Bad request");
    const { max, planCheck, loans, unread, loansUnknown } = await readSafe(ctx);
    const { urgent, standing } = await loanFacts(ctx);
    const openProposal = await hasOpenProposal(ctx);
    return await runChat({ ctx, messages: body.messages, model: getChatModel({ maxCash: max, urgent, facts: { hasLoan: loans.length > 0, openProposal, standing } }), maxCash: max, urgent, planCheck, hasLoan: loans.length > 0, openProposal, standing, loansNote: loansNote(loans, loansUnknown, unread) });
  } catch (err) {
    return toResponse(err);
  }
}
