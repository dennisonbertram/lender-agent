import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_OWNER } from "@/server/mock/seed";
import { safeContext } from "@/server/request";
import { createTestWorld, type TestWorld } from "../../../../tests/helpers/world";
import type { Address, Hex, LoanPosition } from "@/shared/types";
import { getReserveRuntime, resetMockReserveChain, setReserveRuntimeForTests } from "./runtime";
import { saveLink } from "../../../../tests/helpers/reserve-setup";
import type { ExecLink } from "../types";
import type { FixtureReserveChain } from "./fixture-chain";
import { formatExactRawAmount, reserveNowOption, useReserveNow } from "./use-now";
import { setReserveTrigger } from "./store";

const MAIN = "0x1111111111111111111111111111111111111111" as Address;
const RESERVE = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
let w: TestWorld;
let link: ExecLink;
let loan: LoanPosition;

function position(debt: number): LoanPosition {
  return {
    chainId: 8453, safe: MAIN, lender: "aave-v3", id: `8453:${MAIN.toLowerCase()}:aave-v3`,
    collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 1_500 }],
    debt: [{ asset: "USDC", token: USDC, amount: debt, usd: debt }],
    healthFactor: (1_500 * 0.8) / debt, liquidationThreshold: 0.8, ltv: 0.7, mixed: false, blockNumber: 1n,
  };
}

async function setup() {
  process.env.MOCK = "1";
  w = await createTestWorld();
  const safeId = await w.trackSafe(MAIN, { name: "Treasury Safe", agentAdded: true });
  for (const address of [MAIN, RESERVE]) {
    w.services.fixture.setOwners(8453, address, [MOCK_OWNER], 1);
  }
  const { cookie } = await w.signIn(MOCK_OWNER);
  const ctx = await safeContext(w.req("/", { cookie }), MAIN, w.services);
  const runtime = getReserveRuntime(w.services, () => {});
  link = {
    safeId, chainId: 8453, mainSafe: MAIN, reserveSafe: RESERVE,
    roles: "0x3333333333333333333333333333333333333333", executor: runtime.signer.address,
    token: USDC, tokenSymbol: "USDC", tokenDecimals: 6, trigger: 1.3, attempt: 1,
    active: true, fromBlock: 1n,
  };
  await saveLink(w.db, link, "10000000000");
  const chain = runtime.chain as FixtureReserveChain;
  chain.setup(link, { dailyLimitRaw: 10_000_000_000n, members: [link.executor] });
  w.services.fixture.setBalances(8453, RESERVE, { USDC: 10_000 });
  loan = position(1_000);
  w.services.fixture.setPosition(8453, MAIN, loan);
  const prepare = vi.spyOn(chain, "prepare");
  return { ctx, chain, prepare };
}

beforeEach(() => { process.env.MOCK = "1"; });
afterEach(() => { w?.reset(); resetMockReserveChain(); setReserveRuntimeForTests(undefined); delete process.env.MOCK; });

describe("Use reserve now confirmation binding", () => {
  it("shows a concise exact quote without dropping significant USDC decimals", () => {
    expect(formatExactRawAmount(100_000_000n, 6)).toBe("100");
    expect(formatExactRawAmount(100_500_000n, 6)).toBe("100.5");
    expect(formatExactRawAmount(100_000_001n, 6)).toBe("100.000001");
  });

  it("accepts ordinary debt accrual while capping the request at the original confirmed maximum", async () => {
    const { ctx, prepare } = await setup();
    const option = await reserveNowOption(ctx, loan.id);
    expect(option.enabled).toBe(true);
    const reviewed = option.binding!;
    const confirmedMaximum = BigInt(reviewed.maxAmountRaw);
    // One raw USDC unit of interest arrives while the owner reviews the confirmation.
    loan = position(1_000.000001);
    w.services.fixture.setPosition(8453, MAIN, loan);
    const result = await useReserveNow(ctx, loan.id, { confirm: true, binding: reviewed });

    expect(result.status).toBe("done");
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![1]).toBeGreaterThan(0n);
    expect(prepare.mock.calls[0]![1]).toBeLessThanOrEqual(confirmedMaximum);
  });

  it.each([
    ["reserve balance", 12, 10_000_000_000n, 12_000_000n],
    ["remaining daily allowance", 10_000, 7_000_000n, 7_000_000n],
  ])("caps a reviewed maximum to the live %s", async (_limit, balanceUsdc, allowanceBalance, expectedCap) => {
    const { ctx, chain, prepare } = await setup();
    const option = await reserveNowOption(ctx, loan.id);
    const state = chain.state(link);
    if (!state) throw new Error("fixture policy missing");
    state.allowance.balance = allowanceBalance;
    w.services.fixture.setBalances(8453, RESERVE, { USDC: balanceUsdc });

    const result = await useReserveNow(ctx, loan.id, { confirm: true, binding: option.binding! });

    expect(result.status).toBe("done");
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![1]).toBeGreaterThan(0n);
    expect(prepare.mock.calls[0]![1]).toBeLessThanOrEqual(expectedCap);
  });

  it("sizes against a lower current need without raising the reviewed maximum", async () => {
    const { ctx, prepare } = await setup();
    const option = await reserveNowOption(ctx, loan.id);
    const reviewedMaximum = BigInt(option.binding!.maxAmountRaw);
    loan = position(980);
    w.services.fixture.setPosition(8453, MAIN, loan);

    const result = await useReserveNow(ctx, loan.id, { confirm: true, binding: option.binding! });

    expect(result.status).toBe("done");
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![1]).toBeGreaterThan(0n);
    expect(prepare.mock.calls[0]![1]).toBeLessThan(reviewedMaximum);
  });

  it("rejects a confirmation that changes the exact loan identity", async () => {
    const { ctx, prepare } = await setup();
    const option = await reserveNowOption(ctx, loan.id);
    const tampered = { ...option.binding!, loanId: `8453:${MAIN.toLowerCase()}:morpho-blue` };

    await expect(useReserveNow(ctx, loan.id, { confirm: true, binding: tampered })).rejects.toMatchObject({ status: 409 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a reviewed quote after the Reserve trigger policy changes", async () => {
    const { ctx, prepare } = await setup();
    const option = await reserveNowOption(ctx, loan.id);
    await setReserveTrigger(w.db, link.safeId, 8453, 1.25);

    await expect(useReserveNow(ctx, loan.id, { confirm: true, binding: option.binding! })).rejects.toMatchObject({ status: 409 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses one deterministic run key when the same reviewed confirmation is retried", async () => {
    const { ctx, prepare } = await setup();
    const option = await reserveNowOption(ctx, loan.id);
    const binding = option.binding!;

    const first = await useReserveNow(ctx, loan.id, { confirm: true, binding });
    const retry = await useReserveNow(ctx, loan.id, { confirm: true, binding });
    expect(first.status).toBe("done");
    if (first.status !== "done") throw new Error("first manual repayment was not completed");
    expect(retry).toMatchObject({ status: "done", runId: first.runId, txHash: first.txHash });
    expect(prepare).toHaveBeenCalledOnce();
  });
});
