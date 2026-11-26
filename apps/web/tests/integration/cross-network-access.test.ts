// G4: network-scoped routes need ownership on that network. A wallet that owns the Safe only on Arbitrum is refused for Base data.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { GET as RESERVE_GET } from "@/app/api/safes/[address]/reserve/route";
import { POST as RESERVE_CHECK } from "@/app/api/safes/[address]/reserve/check/route";
import { POST as RESERVE_OFF } from "@/app/api/safes/[address]/reserve/off/route";
import { POST as RESERVE_POLICY } from "@/app/api/safes/[address]/reserve/policy/route";
import { GET as MOVE_GET } from "@/app/api/safes/[address]/moves/[id]/route";
import { POST as MOVE_SEND } from "@/app/api/safes/[address]/moves/[id]/send/route";
import { POST as MOVE_PLAN } from "@/app/api/safes/[address]/moves/route";
import { GET as LOAN_GET } from "@/app/api/safes/[address]/loans/[loanId]/route";
import { POST as LOAN_CLOSE } from "@/app/api/safes/[address]/loans/[loanId]/close/route";
import { GET as USE_NOW } from "@/app/api/safes/[address]/reserve/use-now/route";
import { moves } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { createTestWorld, type TestWorld } from "../helpers/world";

const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const p = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ address: MOCK_SAFE as string, ...extra }) }) as { params: Promise<{ address: string; id: string; loanId: string }> };
let w: TestWorld;
let cookie: string;
let moveId: string;

beforeEach(async () => {
  w = await createTestWorld();
  const safeId = await w.trackSafe(MOCK_SAFE, { chainIds: [8453, 42161] });
  w.services.fixture.setOwners(8453, SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  w.services.fixture.setOwners(42161, SAFE, [MOCK_STRANGER], 1);
  cookie = (await w.signIn(MOCK_STRANGER)).cookie;
  const [row] = await w.db.insert(moves).values({
    id: "m1", safeId, fromChain: 8453, toChain: 42161, asset: "ETH", status: "quoted", quote: {}, spec: {},
    quotedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
  }).returning();
  moveId = row!.id;
});
afterEach(() => w.reset());

describe("an Arbitrum-only owner is refused Base data", () => {
  it("reserve GET and check", async () => {
    expect((await RESERVE_GET(w.req("/?chainId=8453", { cookie }), p())).status).toBe(403);
    expect((await RESERVE_GET(w.req("/", { cookie }), p())).status).toBe(403);
    const check = await RESERVE_CHECK(w.req("/", { method: "POST", cookie, json: { chainId: 8453, reserveSafe: MOCK_SAFE, dailyLimitUsd: 1, triggerHf: 1.5 } }), p());
    expect(check.status).toBe(403);
  });

  it("reserve off and policy", async () => {
    expect((await RESERVE_OFF(w.req("/", { method: "POST", cookie, json: { chainId: 8453 } }), p())).status).toBe(403);
    expect((await RESERVE_POLICY(w.req("/", { method: "POST", cookie, json: { chainId: 8453, dailyLimitUsd: "100" } }), p())).status).toBe(403);
  });

  it("a move that starts on Base: details, send and plan", async () => {
    expect((await MOVE_GET(w.req("/", { cookie }), p({ id: moveId }))).status).toBe(403);
    expect((await MOVE_SEND(w.req("/", { method: "POST", cookie }), p({ id: moveId }))).status).toBe(403);
    expect((await MOVE_PLAN(w.req("/", { method: "POST", cookie, json: { cash: 1000, asset: "ETH", network: "base" } }), p())).status).toBe(403);
  });

  it("a Base loan: detail, close, use-now", async () => {
    const loanId = encodeURIComponent(`8453:${SAFE.toLowerCase()}:aave-v3`);
    expect((await LOAN_GET(w.req("/", { cookie }), p({ loanId }))).status).toBe(404);
    expect((await LOAN_CLOSE(w.req("/", { method: "POST", cookie }), p({ loanId }))).status).toBeGreaterThanOrEqual(403);
    expect((await USE_NOW(w.req(`/?loanId=${loanId}`, { cookie }), p())).status).toBeGreaterThanOrEqual(403);
  });
});
