// E2E-9 (M6) on the MOCK stack: a linked Reserve, a price fall that triggers a repay card, "Use reserve now" with
// its dialog, and turn off. Fixture chain reader + the fixture Roles stand-in (same rules as the real modifier:
// membership, allowance charged by the amount requested). The real modifier is covered by the fork tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { BALANCED_HF } from "@/lib/loan-math";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { ANVIL_KEYS } from "../helpers/anvil";
import { saveLink } from "../helpers/reserve-setup";
import { privateKeyToAccount } from "viem/accounts";
import { MOCK_COSIGNER, MOCK_OWNER } from "@/server/mock/seed";
import { activity, messages, reserveRuns, users } from "@/server/db/schema";
import { DevEmailProvider } from "@/server/email/provider";
import { runMonitorTick } from "@/server/monitor/tick";
import { GET as USE_NOW_GET, POST as USE_NOW_POST } from "@/app/api/safes/[address]/reserve/use-now/route";
import { safeContext } from "@/server/request";
import { allowanceNow, reserveStatus } from "@/server/reserve";
import { reserveNowOption, useReserveNow } from "@/server/reserve/executor";
import { createFixtureReserveChain } from "@/server/reserve/executor/fixture-chain";
import { setReserveRuntimeForTests } from "@/server/reserve/executor/runtime";
import { DevExecutorSigner } from "@/server/reserve";
import { loadReserveLink } from "@/server/reserve/executor/store";
import { turnReserveOff } from "@/server/reserve/policy-change";
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
const runs = () => w.db.select().from(reserveRuns).orderBy(reserveRuns.id);
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
  chain = createFixtureReserveChain(fx);
  chain.setup(link, { dailyLimitRaw: LIMIT, members: [executor] });
  email = new DevEmailProvider();
  operatorAlert.mockReset();
  setReserveRuntimeForTests({ chain, signer: new DevExecutorSigner(ANVIL_KEYS[4]), operatorAlert });
});
afterEach(() => { delete process.env.MOCK; setReserveRuntimeForTests(undefined); w.reset(); });

describe("E2E-9 Reserve: link, price fall, use now, turn off (mock stack)", () => {
  it("runs the whole journey", async () => {
    // Linked and on: the one status the page, sidebar and header read.
    expect(await reserveStatus({ address: MAIN, chainId: 8453 }, { db: w.db, ttlMs: 0 })).toMatchObject({ kind: "armed", label: "On", armed: true });

    // Above the trigger: nothing happens.
    await tick();
    expect(await runs()).toHaveLength(0);

    // The price falls: health 1.23 is below 1.30. The same tick repays through the role.
    w.services.fixture.setPosition(8453, MAIN, position(6_500));
    await tick();
    const [auto] = await runs();
    expect(auto).toMatchObject({ status: "done", origin: "auto" });
    // The allowance is charged by the amount requested; never type(uint256).max.
    expect(LIMIT - (await left())).toBe(BigInt(auto!.requestedRaw));
    expect(BigInt(auto!.requestedRaw)).toBeLessThan(LIMIT);
    expect(auto!.hfAfter!).toBeCloseTo(BALANCED_HF, 2); // repays up to the Balanced target, above the default Watch level
    const parts = (await w.db.select().from(messages).where(eq(messages.safeId, safeId))).flatMap((m) => (m.message as { parts: { type: string; data?: Record<string, unknown> }[] }).parts);
    const card = parts.find((p) => p.type === "data-reserve")!.data!;
    expect(String(card.what)).toMatch(/^Repaid [\d,.]+ USDC from your Reserve Safe/);
    expect(String(card.why)).toMatch(/below your reserve trigger of 1\.30/);
    expect(email.sent.filter((m) => m.subject === "Your reserve repaid part of your loan")).toHaveLength(1);
    const rows = await w.db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(rows.find((a) => a.kind === "reserve")!.text).toMatch(/^Used \$[\d,.]+ from Reserve Safe on your Aave v3 loan\. Done without your signature\.$/);
    await tick();
    expect(await runs()).toHaveLength(1);

    // Use reserve now: above the trigger, below the target. The dialog names the amount; confirming runs it.
    w.services.fixture.setPosition(8453, MAIN, position(5_600)); // health 1.43
    const ctx = await ctxOf();
    const option = await reserveNowOption(ctx, loanId());
    expect(option).toMatchObject({ enabled: true, label: "Runs now, without a signature" });
    expect(option.confirm).toMatch(/^Use up to \$[\d,]+(\.\d{2}|\.\d{6})? from reserve\?$/);
    await expect(useReserveNow(ctx, loanId(), { confirm: false, binding: option.binding })).rejects.toMatchObject({ status: 400 });
    expect((await useReserveNow(ctx, loanId(), { confirm: true, binding: option.binding })).status).toBe("done");
    expect((await runs()).map((r) => r.origin)).toEqual(["auto", "now"]);

    // Turn off: the executor stops at once, the permission on-chain is still active until the owners sign.
    const off = await turnReserveOff(ctx, 8453);
    expect(off.permission).toMatchObject({ agent: "stopped", chain: "active" });
    expect((await loadReserveLink(w.db, safeId, 8453))!.active).toBe(false);
    w.services.fixture.setPosition(8453, MAIN, position(6_500));
    await tick();
    expect(await runs()).toHaveLength(2);
    // The owners sign the removal: the role call is refused by the chain.
    chain.revoke(link, executor);
    expect(await chain.repay(link, 1_000_000n, new DevExecutorSigner(ANVIL_KEYS[4]))).toMatchObject({ ok: false, name: "NoMembership" });
    expect(operatorAlert).not.toHaveBeenCalled();
  }, 60_000);
});

describe("use now: stale main-Safe ownership (G4)", () => {
  const params = () => ({ params: Promise.resolve({ address: MAIN as string }) });
  const post = (cookie: string, binding: NonNullable<Awaited<ReturnType<typeof reserveNowOption>>["binding"]>) =>
    USE_NOW_POST(w.req("/", { method: "POST", cookie, json: { loanId: loanId(), confirm: true, binding } }), params());

  it("a wallet removed from the main Safe after the access cache was warmed gets 403 and moves nothing; a current owner still succeeds", async () => {
    w.services.fixture.setPosition(8453, MAIN, position(5_600)); // health 1.43: above the trigger, in the "use now" band
    const owner = (await w.signIn(MOCK_OWNER)).cookie;
    // An earlier request warmed the 15 s ownership cache — here, the page's option GET.
    const quote = await USE_NOW_GET(w.req(`/?loanId=${encodeURIComponent(loanId())}`, { cookie: owner }), params());
    expect(quote.status).toBe(200);
    const binding = (await quote.json()).binding;
    expect(binding).toMatchObject({ loanId: loanId(), reserveSafe: RESERVE.toLowerCase() });

    // The other owners remove this wallet from the main Safe. The cached access still lists it.
    w.services.fixture.setOwners(8453, MAIN, [MOCK_COSIGNER], 1);
    const submit = vi.spyOn(chain, "submit"); // the mutation point of the durable prepare/submit seam
    const denied = await post(owner, binding);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "You are not an owner of this Safe on this network" });
    expect(submit).not.toHaveBeenCalled();
    expect(chain.prepared).toHaveLength(0); // nothing was even signed
    expect(await runs()).toHaveLength(0);

    // A wallet that still owns both Safes moves funds on the same POST.
    const cosigner = (await w.signIn(MOCK_COSIGNER)).cookie;
    const ok = await post(cosigner, binding);
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("done");
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await runs()).map((r) => r.origin)).toEqual(["now"]);
  }, 60_000);
});
