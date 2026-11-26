// Vercel Cron entry for the worker: one pass of `runDueJobs` per call (Vercel has no long-running process).
// Per-job locks in worker/locks.ts stop overlapping invocations.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { getServices } from "@/server/services";
import { runDueJobs } from "@/worker/loop";
import { jobs } from "@/worker/jobs";

export const dynamic = "force-dynamic";
// Jobs run in sequence; leave room so a slow pass finishes and releases its locks (Pro allows 300 s).
export const maxDuration = 300;

/** Cron fires about once a minute with jitter; a job due every 60s would otherwise miss alternate calls. */
const CRON_SLACK_MS = 5_000;

function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req.headers.get("authorization"))) return new NextResponse("Unauthorized", { status: 401 });
  if (process.env.MOCK === "1") return new NextResponse("Not found", { status: 404 });
  const services = getServices();
  const results = await runDueJobs({
    db: await getDb(),
    reader: services.reader,
    services,
    workerId: "vercel-cron",
    now: () => new Date(),
    jobs: jobs().map((j) => ({ ...j, intervalMs: Math.max(0, j.intervalMs - CRON_SLACK_MS) })),
  });
  return NextResponse.json({ results });
}
