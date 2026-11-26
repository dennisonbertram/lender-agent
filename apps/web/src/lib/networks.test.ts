import { describe, expect, it } from "vitest";
import { BASE_PRICES, NETWORKS, TREASURY, VENUES } from "../../tests/fixtures/legacy-data";
import { maxCashSafe, plansFor, resolveHolding, type BridgeQuote } from "@/lib/cash-plan";
import { routeIntent } from "@/lib/intents";
import { networkRows, networkSetup, addNetwork, deposit, balanceGroups, balancesOn, createSafe, deriveAgent, markDeployed, setNetworkAgent, totalBalances, venuesOn } from "@/lib/networks";

const setup = { address: "0x7be2a91c4d05f3e8b6a7c1d92e04f58a3b6cc41a", ownerCount: 1, threshold: 1 };
const bridgeQuote: BridgeQuote = (from, to, asset, amount) => ({ from, to, asset, amount, feeUsd: 5, minutes: 12 });
const resolve = (safe: Parameters<typeof resolveHolding>[0], want: Parameters<typeof resolveHolding>[4] = {}) =>
  resolveHolding(safe, BASE_PRICES, 3000, 1.6, want, VENUES, NETWORKS, bridgeQuote, []);

describe("Safe network setup", () => {
  it("uses the address supplied by the caller on every network", () => {
    const a = createSafe({ id: "a", name: "A", ...setup, networks: ["ethereum", "base"] });
    const b = createSafe({ id: "b", name: "B", ...setup, networks: ["arbitrum"] });
    expect(a.address).toBe(setup.address);
    expect(b.address).toBe(a.address);
    expect(a.address).toMatch(/^0x[0-9a-f]{40}$/);
  });
  it("starts every chosen network as not deployed, and adding a network keeps the address", () => {
    const s = createSafe({ id: "a", name: "A", ...setup, networks: ["ethereum", "base"] });
    expect(s.networks).toEqual([{ id: "ethereum", deployed: false, agent: false }, { id: "base", deployed: false, agent: false }]);
    const t = addNetwork(s, "arbitrum", true);
    expect(t.address).toBe(s.address);
    expect(t.networks.map((n) => n.id)).toEqual(["ethereum", "base", "arbitrum"]);
    expect(t.networks[2].agent).toBe(true);
    expect(addNetwork(t, "arbitrum", false).networks).toHaveLength(3);
  });
});

describe("lenders by network", () => {
  const ids = (n: Parameters<typeof venuesOn>[0]) => venuesOn(n, VENUES).map((v) => v.id).sort();
  it("filters venues to the network", () => {
    expect(ids("ethereum")).toEqual(["aave", "compound", "morpho", "spark"]);
    // Sample data: Compound v3 is not listed on Base, so the cross-network demo has a lender only on Ethereum.
    expect(ids("base")).toEqual(["aave", "morpho"]);
    expect(ids("gnosis")).toEqual(["aave", "spark"]);
  });
  it("a plan on Base never offers Spark or Compound", () => {
    const bal = { ETH: 5, wstETH: 0, WBTC: 0 };
    const plans = plansFor({ cash: 3000, months: 12, targetHf: 1.6, asset: "ETH", network: "base" }, bal, BASE_PRICES, VENUES, []);
    expect(plans.map((p) => p.venue.id).sort()).toEqual(["aave", "morpho"]);
    expect(plans.some((p) => p.feasible)).toBe(true);
  });
});

describe("balances per network", () => {
  it("Treasury has everything on Ethereum plus USDC on Base", () => {
    expect(balancesOn(TREASURY, "base").USDC).toBe(2000);
    expect(balancesOn(TREASURY, "ethereum").ETH).toBe(8);
    expect(balancesOn(TREASURY, "arbitrum").ETH).toBe(0);
    expect(totalBalances(TREASURY, NETWORKS).USDC).toBe(45000 + 2000);
  });
  it("groups per network with a subtotal each, skipping empty networks", () => {
    const g = balanceGroups(TREASURY, BASE_PRICES, NETWORKS);
    expect(g.map((x) => x.network)).toEqual(["ethereum", "base"]);
    expect(g[1].assets).toEqual([{ asset: "USDC", amount: 2000 }]);
    expect(g[1].usd).toBe(2000);
    expect(g[0].usd).toBe(8 * 2745 + 6 * 3210 + 0.5 * 74900 + 45000 + 40000);
    expect(balanceGroups(createSafe({ id: "x", name: "x", ...setup, networks: ["base"] }), BASE_PRICES, NETWORKS)).toEqual([]);
  });
});

describe("agent per network", () => {
  const s = createSafe({ id: "a", name: "A", ...setup, networks: ["ethereum", "base"] });
  it("safe.agent is on when the agent is a proposer on at least one network", () => {
    expect(s.agent).toBe(false);
    const one = setNetworkAgent(s, "base", true);
    expect(one.agent).toBe(true);
    expect(one.networks.map((n) => n.agent)).toEqual([false, true]);
    const both = setNetworkAgent(one, "ethereum", true);
    expect(setNetworkAgent(both, "base", false).agent).toBe(true);
    expect(setNetworkAgent(setNetworkAgent(both, "base", false), "ethereum", false).agent).toBe(false);
  });
  it("deriveAgent reads the network list", () => {
    expect(deriveAgent([{ id: "base", deployed: false, agent: false }])).toBe(false);
    expect(deriveAgent([{ id: "base", deployed: false, agent: false }, { id: "ethereum", deployed: true, agent: true }])).toBe(true);
  });
});

describe("planning against holdings on a network", () => {
  const base = deposit(createSafe({ id: "x", name: "x", ...setup, networks: ["ethereum", "base"] }), "base", { ETH: 5 });
  it("finds the holding where the funds are, and only that network's lenders", () => {
    expect(resolve(base)).toEqual({ network: "base", asset: "ETH" });
    expect(maxCashSafe(base, BASE_PRICES, 1.6, VENUES, NETWORKS)).toBeGreaterThan(0);
    expect(maxCashSafe(base, BASE_PRICES, 1.6, VENUES, NETWORKS, "ethereum")).toBe(0);
  });
  it("with the same asset on two networks, the wished network wins", () => {
    const both = deposit(base, "ethereum", { ETH: 8 });
    expect(resolve(both, { network: "base" }).network).toBe("base");
    expect(resolve(both).network).toBe("ethereum"); // more value
  });
  it("chat intents carry a named network into plan and compare blocks", () => {
    expect(routeIntent("I need $3,000 on Base", { hasLoans: false, balances: totalBalances(base, NETWORKS), maxCash: () => 7500 })!.block).toMatchObject({ kind: "plan", cash: 3000, network: "base" });
    expect(routeIntent("compare lenders on arbitrum", { hasLoans: false, balances: totalBalances(base, NETWORKS), maxCash: () => 7500 })!.block).toMatchObject({ kind: "compare", network: "arbitrum" });
    expect(routeIntent("I need $3,000", { hasLoans: false, balances: totalBalances(base, NETWORKS), maxCash: () => 7500 })!.block).not.toHaveProperty("network");
  });
});

function markDeployedFor(s: ReturnType<typeof createSafe>, n: Parameters<typeof markDeployed>[1]) { return markDeployed(s, n); }

describe("Settings networks (BP-35)", () => {
  const safe = setNetworkAgent(markDeployedFor(createSafe({ id: "n", name: "N", ...setup, networks: ["base", "arbitrum"] }), "base"), "base", true);
  it("each network is set up, ready on first use, or not added", () => {
    expect(networkSetup(safe, "base")).toBe("deployed");
    expect(networkSetup(safe, "arbitrum")).toBe("ready");
    expect(networkSetup(safe, "optimism")).toBe("not-added");
  });
  it("rows say the setup and the agent on or off, and list networks that are not added last", () => {
    const rows = networkRows(safe, NETWORKS.filter((n) => ["base", "arbitrum", "optimism"].includes(n.id)));
    expect(rows.map((r) => [r.id, r.setup, r.agent])).toEqual([["base", "deployed", true], ["arbitrum", "ready", false], ["optimism", "not-added", false]]);
    expect(rows[0].line).toBe("Set up · Agent on");
    expect(rows[1].line).toBe("Ready, set up automatically on first use · Agent off");
    expect(rows[2].line).toBe("Not added");
  });
});
