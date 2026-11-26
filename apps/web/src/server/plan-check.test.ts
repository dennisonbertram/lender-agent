import { describe, expect, it } from "vitest";
import { createFixtureReader } from "@/server/chain/fixture";
import { MOCK_SAFE } from "@/server/mock/seed";
import { liveInputs } from "./market-inputs";
import type { ChainId } from "@/shared/types";
import { planCheckFor, planRefusal } from "./plan-check";
import { collateralFor, planFor } from "@/lib/cash-plan";
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import { createFixtureLenders } from "@/server/lenders/fixture";

import { chatToolsFor, chatTools } from "./agent/tools";

const inputsWith = async (eth: number) => {
  const reader = createFixtureReader();
  reader.setBalances(8453, MOCK_SAFE, { ETH: eth });
  return liveInputs(reader, 8453, MOCK_SAFE);
};
const run = (tools: typeof chatTools, cash: number) => (tools.planLoan.execute as (i: unknown, o: unknown) => Promise<unknown>)({ cash }, { toolCallId: "t", messages: [] });
const modelSees = (output: unknown) => (chatTools.planLoan.toModelOutput as (o: { output: unknown }) => unknown)({ output });

describe("planRefusal: decided before the plan card is drawn", () => {
  it("$20 against about $375 of ETH is a plan: no refusal, so nothing to flash and swap", async () => {
    const inputs = await inputsWith(375 / (await inputsWith(1)).prices.ETH);
    expect(planRefusal(inputs, 20)).toBeNull();
    const tools = chatToolsFor((cash) => ({ refusal: planRefusal(inputs, cash) }));
    const block = await run(tools, 20);
    expect(block).toEqual({ kind: "plan", cash: 20 });
    expect(modelSees(block)).toEqual({ type: "json", value: { ok: true } });
  });

  it("collateral that cannot back the smallest loan is a refusal card, and the model is told it is one", async () => {
    const inputs = await inputsWith(0.001);
    const refusal = planRefusal(inputs, 20);
    expect(refusal).toMatchObject({ reason: "not_enough_collateral" });
    expect(refusal!.needUsd).toBeGreaterThan(0);
    const block = await run(chatToolsFor((cash) => ({ refusal: planRefusal(inputs, cash) })), 20);
    expect(block).toMatchObject({ kind: "plan", cash: 20, refusal: { reason: "not_enough_collateral" } });
    expect(modelSees(block)).toEqual({ type: "json", value: { ok: false, reason: "not_enough_collateral", needUsd: refusal!.needUsd } });
  });

  it("0.008 ETH at the live price cannot back $10 once collateral rounds up: refused, as the quote would", async () => {
    const price = (await inputsWith(1)).prices.ETH;
    const inputs = await inputsWith(0.008);
    expect(inputs.balances.ETH * price * 0.8).toBeGreaterThan(10); // the theoretical limit passes...
    const q = planFor({ cash: 10, months: 12, targetHf: DEFAULT_LEVELS.warn, asset: "ETH", network: "base" }, inputs.balances.ETH, price, inputs.lenders[0].venue!);
    expect(q.feasible).toBe(q.collateral <= 0.008);
    expect(planRefusal(inputs, 10) === null).toBe(q.feasible);
  });

  it("collateral rounds to 4 significant digits, never below the asset's decimals", () => {
    const m = { lt: 0.8, maxLtv: 0.75 };
    expect(collateralFor(10, 1.6, 3000, m, "ETH")).toBe(0.006667);
    expect(collateralFor(10000, 1.6, 2745, { lt: 0.86, maxLtv: 0.8 }, "ETH")).toBe(6.778);
    expect(collateralFor(1, 1.6, 1e12, m, "WBTC")).toBe(0.00000001);
  });

  it("checks the network the plan is for: empty Base, 1 ETH on Arbitrum, an Arbitrum plan is fine", async () => {
    const reader = createFixtureReader();
    reader.setBalances(8453, MOCK_SAFE, {});
    reader.setBalances(42161, MOCK_SAFE, { ETH: 1 });
    const read = (id: ChainId) => liveInputs(reader, id, MOCK_SAFE, createFixtureLenders());
    const base = await read(8453);
    const check = planCheckFor(read, [base], [8453, 42161]);
    expect(await check(10, { network: "arbitrum" })).toMatchObject({ refusal: null, network: "arbitrum" });
    expect(await check(10, { network: "arbitrum", asset: "ETH" })).toMatchObject({ refusal: null });
    expect(await check(10, {})).toMatchObject({ refusal: { reason: "not_enough_collateral" }, network: "base" }); // no eligible list means Base, which is empty
    expect(await check(10, { network: "arbitrum", asset: "wstETH" })).toMatchObject({ refusal: { reason: "not_enough_collateral" } });
    const unowned = planCheckFor(read, [base], [8453]);
    expect(await unowned(10, { network: "arbitrum" })).toBeNull();
  });

  it("chooses the network that has the requested collateral, not another network's funded asset", async () => {
    const reader = createFixtureReader();
    reader.setBalances(8453, MOCK_SAFE, { ETH: 8 });
    reader.setBalances(42161, MOCK_SAFE, { wstETH: 8 });
    const read = (id: ChainId) => liveInputs(reader, id, MOCK_SAFE, createFixtureLenders());
    const base = await read(8453);
    const arb = await read(42161);
    const check = planCheckFor(read, [base, arb], [8453, 42161]);
    expect(await check(500, { asset: "wstETH" })).toMatchObject({ refusal: null, network: "arbitrum" });
  });

  it("keeps a plan edit on the open proposal's network when both networks can fund loans", async () => {
    const reader = createFixtureReader();
    reader.setBalances(8453, MOCK_SAFE, { ETH: 8 });
    reader.setBalances(42161, MOCK_SAFE, { ETH: 8 });
    const read = (id: ChainId) => liveInputs(reader, id, MOCK_SAFE, createFixtureLenders());
    const base = await read(8453);
    const arb = await read(42161);
    const check = planCheckFor(read, [base, arb], [8453, 42161], "arbitrum");
    expect(await check(3000, { edit: true })).toMatchObject({ refusal: null, network: "arbitrum" });
  });

  it("without a check the tool is the plain parameter block", async () => {
    expect(await run(chatToolsFor(), 20)).toEqual({ kind: "plan", cash: 20 });
  });
});
