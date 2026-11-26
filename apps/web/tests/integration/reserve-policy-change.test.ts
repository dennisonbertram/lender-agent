// E2E-9 (M6) on the MOCK stack: a linked Reserve, a price fall that triggers a repay card, "Use reserve now" with
// its dialog, and turn off. Fixture chain reader + the fixture Roles stand-in (same rules as the real modifier:
// membership, allowance charged by the amount requested). The real modifier is covered by the fork tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST as OFF } from "@/app/api/safes/[address]/reserve/off/route";
import { POST as POLICY } from "@/app/api/safes/[address]/reserve/policy/route";
import { GET as VIEW } from "@/app/api/safes/[address]/reserve/route";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { ANVIL_KEYS } from "../helpers/anvil";
import { saveLink } from "../helpers/reserve-setup";
import { privateKeyToAccount } from "viem/accounts";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_OWNER_KEY } from "@/server/mock/seed";
import { activity, messages, proposals, reserveRuns, users } from "@/server/db/schema";
import { revokeCall } from "@/server/reserve/policy-change/calls";
import { delegateTypedData } from "@/server/safe/hash";
import { DevEmailProvider } from "@/server/email/provider";
import { runMonitorTick } from "@/server/monitor/tick";
import { safeContext } from "@/server/request";
import { reserveViewOf } from "@/server/reserve/view";
import { allowanceNow, reserveStatus } from "@/server/reserve";
import { reserveNowOption, useReserveNow } from "@/server/reserve/executor";
import { createFixtureReserveChain } from "@/server/reserve/executor/fixture-chain";
import { setReserveRuntimeForTests } from "@/server/reserve/executor/runtime";
import { DevExecutorSigner } from "@/server/reserve";
import { loadReserveLink } from "@/server/reserve/executor/store";
import { reconcilePolicyChanges, requestPolicyChange, turnReserveOff } from "@/server/reserve/policy-change";
import type { ExecLink } from "@/server/reserve/types";
import type { Address, LoanPosition } from "@/shared/types";

const MAIN = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const RESERVE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0009" as Address;
const ROLES = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe00a9" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const executor = privateKeyToAccount(ANVIL_KEYS[4]!).address as Address;
const LIMIT = 5_000_000_000n;

const position = (debt: number): LoanPosition => ({
  chainId: 8453, safe: MAIN, lender: "aave-v3", id: `8453:${MAIN.toLowerCase()}:aave-v3`,
  collateral: [{ asset: "WETH", token: WETH, amount: 5, usd: 10_000 }], debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
  healthFactor: (10_000 * 0.8) / debt, liquidationThreshold: 0.8, ltv: 0.75, mixed: false, blockNumber: 1n,
});

let w: TestWorld;
let safeId: number;
let link: ExecLink;
let chain: ReturnType<typeof createFixtureReserveChain>;
let email: DevEmailProvider;
let t = 0;
const operatorAlert = vi.fn();
const tick = () => runMonitorTick({ db: w.db, reader: w.services.reader, services: w.services, now: new Date(Date.UTC(2026, 0, 1) + ++t * 60_000), log: () => {}, email });
const ctxOf = async () => safeContext(w.req("/", { cookie: (await w.signIn(MOCK_OWNER)).cookie }), MAIN, w.services);
const loanId = () => `8453:${MAIN.toLowerCase()}:aave-v3`;
const runs = () => w.db.select().from(reserveRuns);
const left = async () => { const r = await chain.read(link); return allowanceNow(r.allowance, r.nowSec).left; };

beforeEach(async () => {
  process.env.MOCK = "1"; // the status read-out answers from its mock chain state, as in `MOCK=1`
  w = await createTestWorld();
  const fx = w.services.fixture;
  safeId = await w.trackSafe(MAIN, { agentAdded: true });
  fx.setOwners(8453, RESERVE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  fx.setBalances(8453, RESERVE, { ETH: 0, USDC: 20_000 });
  fx.setPosition(8453, MAIN, position(5_000)); // health 1.60: above the 1.30 trigger
  await w.db.insert(users).values({ address: MOCK_OWNER.toLowerCase(), email: "owner@example.com" });
  link = { safeId, chainId: 8453, mainSafe: MAIN, reserveSafe: RESERVE, roles: ROLES, executor, token: USDC, tokenSymbol: "USDC", tokenDecimals: 6, trigger: 1.3, attempt: 0, active: true, fromBlock: 1n };
  await saveLink(w.db, link, String(LIMIT));
  const fake = w.services.fakes.get(8453)!;
  fake.setOwners(RESERVE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  await fake.addDelegate({ safe: RESERVE, delegator: MOCK_OWNER, delegate: w.services.signer.address, label: "Lender agent", signature: await privateKeyToAccount(MOCK_OWNER_KEY).signTypedData(delegateTypedData(8453, w.services.signer.address)) });
  chain = createFixtureReserveChain(fx);
  chain.setup(link, { dailyLimitRaw: LIMIT, members: [executor] });
  email = new DevEmailProvider();
  operatorAlert.mockReset();
  setReserveRuntimeForTests({ chain, signer: new DevExecutorSigner(ANVIL_KEYS[4]), operatorAlert });
});
afterEach(() => { delete process.env.MOCK; setReserveRuntimeForTests(undefined); w.reset(); });

describe("Reserve policy changes apply only once their Safe transaction executed", () => {
  const deps = () => ({ db: w.db, now: new Date(), log: () => {}, services: w.services });

  it("a new trigger with the current limit is not applied by a matching allowance", async () => {
    const ctx = await ctxOf();
    const res = await requestPolicyChange(ctx, 8453, { dailyLimitUsd: "5000", trigger: "1.50" });
    await reconcilePolicyChanges(deps(), safeId, 8453);
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.3);
    chain.markExecuted(res.safeTxHash);
    await reconcilePolicyChanges(deps(), safeId, 8453);
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.5);
  });

  it("a limit change whose allowance already matches still waits for the transaction", async () => {
    const ctx = await ctxOf();
    const res = await requestPolicyChange(ctx, 8453, { dailyLimitUsd: "4000", trigger: "1.40" });
    chain.setLimit(link, 4_000_000_000n);
    await reconcilePolicyChanges(deps(), safeId, 8453);
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.3);
    chain.markExecuted(res.safeTxHash);
    await reconcilePolicyChanges(deps(), safeId, 8453);
    expect((await loadReserveLink(w.db, safeId, 8453))!.trigger).toBe(1.4);
  });

  it("status is Off with the revoke message once the server off flag is set, even while the chain still allows it", async () => {
    await turnReserveOff(await ctxOf(), 8453);
    const s = await reserveStatus({ address: MAIN, chainId: 8453 }, { db: w.db, ttlMs: 0 });
    expect(s).toMatchObject({ kind: "paused", label: "Off", armed: false });
    expect(s!.banner).toBe("Turning off: waiting for the owners to revoke the role in Safe");
  });
});

describe("Turning off submits the revoke to the Safe service (BP-43)", () => {
  it("off leaves a queued proposal on the Reserve Safe carrying the revoke calldata, and the page view points to it", async () => {
    const res = await turnReserveOff(await ctxOf(), 8453);
    const stored = await w.services.safeService(8453).getMultisigTransaction(res.safeTxHash);
    expect(stored).not.toBeNull();
    expect(stored!.to.toLowerCase()).toBe(ROLES.toLowerCase());
    expect(stored!.data).toBe(revokeCall(link).data);
    const [row] = await w.db.select().from(proposals).where(eq(proposals.safeTxHash, res.safeTxHash));
    expect(row?.stage).toBe("queued");
    const view = await reserveViewOf(await ctxOf(), 8453);
    expect(view).toMatchObject({ revoke: { link: expect.stringContaining("safe.global"), text: "Sign in Safe to remove the permission" } });
    // idempotent: a second press neither duplicates nor fails
    expect((await turnReserveOff(await ctxOf(), 8453)).safeTxHash).toBe(res.safeTxHash);
  });
});

describe("A pending run whose repay cleared the whole loan is reconciled by the next tick", () => {
  it("loan gone, receipt mined: the run is done with card, email and Activity", async () => {
    const TX = "0x" + "ab".repeat(32);
    await w.db.insert(reserveRuns).values({
      safeId, chainId: 8453, loanId: loanId(), key: "auto:gone:1", status: "pending", requestedRaw: "5000000000",
      signedTx: "0x" + "cd".repeat(70), txHash: TX, nonce: 0, executorAddress: executor.toLowerCase(), broadcastAt: new Date(),
      hfBefore: 1.2, origin: "auto",
    });
    w.services.fixture.setPosition(8453, MAIN, null);
    await tick();
    expect((await runs())[0]!.status).toBe("pending"); // not mined yet
    chain.markMined(TX);
    await tick();
    expect((await runs())[0]!.status).toBe("done");
    const runId = (await runs())[0]!.id;
    expect((await w.db.select().from(activity)).some((a) => a.eventKey === `reserve-run:${runId}`)).toBe(true);
    expect((await w.db.select().from(messages)).some((m) => JSON.stringify(m.message).includes("Repaid"))).toBe(true);
  });
});

describe("Reserve routes: off, then the page reads Off", () => {
  const params = { params: Promise.resolve({ address: MAIN }) };
  it("POST /reserve/off stops the executor and returns the revoke proposal; GET /reserve then says Turning off", async () => {
    const { cookie } = await w.signIn(MOCK_OWNER);
    const res = await OFF(w.req(`/api/safes/${MAIN}/reserve/off`, { method: "POST", cookie, json: {} }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ permission: { agent: "stopped", chain: "active" }, link: expect.stringContaining("safe.global") });
    const view = await (await VIEW(w.req(`/api/safes/${MAIN}/reserve`, { cookie }), params)).json();
    expect(view.status).toMatchObject({ kind: "paused", label: "Off", banner: "Turning off: waiting for the owners to revoke the role in Safe" });
  });
  it("POST /reserve/policy refuses a change while the Reserve is off", async () => {
    const { cookie } = await w.signIn(MOCK_OWNER);
    await OFF(w.req(`/api/safes/${MAIN}/reserve/off`, { method: "POST", cookie, json: {} }), params);
    const res = await POLICY(w.req(`/api/safes/${MAIN}/reserve/policy`, { method: "POST", cookie, json: { trigger: "1.5" } }), params);
    expect(res.status).toBe(409);
  });
});
