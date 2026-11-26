import { networkName } from "@/lib/format";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import { CHAIN_NAME, NETWORK_OF, isChainId, type ChainId } from "@/shared/types";
import type { Amounts, Asset, Network, NetworkConfig, PriceMap, Safe, SafeNetwork, Stable, Venue } from "@/lib/types";

export const zeroAmounts = (): Amounts => ({ ETH: 0, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 });

export const venuesOn = (network: Network, venues: readonly Venue[]) => venues.filter((venue) => venue.networks.includes(network));

export const lendersFor = (safe: Safe, from: Network, venues: readonly Venue[]) =>
  venues.filter((venue) => venue.networks.includes(from) || safe.networks.some((network) => venue.networks.includes(network.id)));

export const venuesNotOn = (network: Network, venues: readonly Venue[]) =>
  venues.filter((venue) => !venue.networks.includes(network));

export function networkList(ids: Network[], networks: readonly NetworkConfig[]): string {
  const names = ids.map((id) => networkName(id, networks));
  return names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

export const networksLabel = (ids: Network[], networks: readonly NetworkConfig[]) =>
  ids.length > 3 ? "all " + ids.length + " networks" : networkList(ids, networks);

export const deriveAgent = (safeNetworks: SafeNetwork[]) => safeNetworks.some((network) => network.agent);

const withNetworks = (safe: Safe, networks: SafeNetwork[]): Safe => ({ ...safe, networks, agent: deriveAgent(networks) });

export const agentOn = (safe: Pick<Safe, "networks">, network: Network) => !!safe.networks.find((item) => item.id === network)?.agent;

export const setNetworkAgent = (safe: Safe, network: Network, on: boolean): Safe =>
  withNetworks(safe, safe.networks.map((item) => (item.id === network ? { ...item, agent: on } : item)));

export const setAllAgents = (safe: Safe, on: boolean): Safe =>
  withNetworks(safe, safe.networks.map((item) => ({ ...item, agent: on })));

export const markDeployed = (safe: Safe, network: Network): Safe =>
  withNetworks(safe, safe.networks.map((item) => (item.id === network ? { ...item, deployed: true } : item)));

export const addNetwork = (safe: Safe, network: Network, agent: boolean): Safe =>
  safe.networks.some((item) => item.id === network)
    ? safe
    : withNetworks(safe, [...safe.networks, { id: network, deployed: false, agent }]);

export function createSafe(input: { id: string; name: string; address: string; ownerCount: number; threshold: number; networks: Network[] }): Safe {
  return {
    id: input.id,
    name: input.name,
    address: input.address,
    threshold: String(input.threshold) + " of " + input.ownerCount,
    agent: false,
    networks: input.networks.map((id) => ({ id, deployed: false, agent: false })),
    balances: {},
  };
}

export const balancesOn = (safe: Safe, network: Network): Amounts => safe.balances[network] ?? zeroAmounts();

export function totalBalances(safe: Safe, networks: readonly NetworkConfig[]): Amounts {
  const total = zeroAmounts();
  for (const network of networks) {
    const balance = balancesOn(safe, network.id);
    for (const asset of Object.keys(total) as (Asset | Stable)[]) total[asset] += balance[asset];
  }
  return total;
}

export function balanceGroups(safe: Safe, prices: PriceMap, networks: readonly NetworkConfig[]) {
  return networks.flatMap(({ id }) => {
    const balance = balancesOn(safe, id);
    const assets = (Object.keys(balance) as (Asset | Stable)[])
      .filter((asset) => balance[asset] > 0)
      .map((asset) => ({ asset, amount: balance[asset] }));
    return assets.length
      ? [{ network: id, assets, usd: assets.reduce((sum, item) => sum + item.amount * prices[item.asset], 0) }]
      : [];
  });
}

export const deposit = (safe: Safe, network: Network, amounts: Partial<Amounts>): Safe => {
  const next = { ...balancesOn(safe, network) };
  for (const asset of Object.keys(amounts) as (Asset | Stable)[]) next[asset] += amounts[asset] ?? 0;
  return { ...safe, balances: { ...safe.balances, [network]: next } };
};

/** Where a network stands for a Safe: set up there, ready (set up automatically on first use), or not added. */
export type NetworkSetup = "deployed" | "ready" | "not-added";

export const networkSetup = (safe: Pick<Safe, "networks">, network: Network): NetworkSetup => {
  const item = safe.networks.find((n) => n.id === network);
  return !item ? "not-added" : item.deployed ? "deployed" : "ready";
};

const SETUP_TEXT: Record<NetworkSetup, string> = { deployed: "Set up", ready: "Ready, set up automatically on first use", "not-added": "Not added" };

export type NetworkRow = { id: Network; name: string; setup: NetworkSetup; agent: boolean; line: string };

/** One Settings row per network, in the order given: the Safe's own networks and the ones it could add. */
export const networkRows = (safe: Pick<Safe, "networks">, networks: readonly NetworkConfig[]): NetworkRow[] =>
  networks.map(({ id, name }) => {
    const setup = networkSetup(safe, id);
    const agent = agentOn(safe, id);
    return { id, name, setup, agent, line: setup === "not-added" ? SETUP_TEXT[setup] : `${SETUP_TEXT[setup]} · Agent ${agent ? "on" : "off"}` };
  });

/** The chain id loans are offered on for a network the app serves (Base, Arbitrum), else null. */
export const servedChainOf = (network: Network): ChainId | null => SERVED_CHAIN_IDS.filter(isChainId).find((chainId) => NETWORK_OF[chainId] === network) ?? null;

/** The networks the app serves, as the Settings panel lists them: chain id, domain network id and display name. */
export const servedNetworks = (): (NetworkConfig & { chainId: ChainId })[] =>
  SERVED_CHAIN_IDS.filter(isChainId).map((chainId) => ({ chainId, id: NETWORK_OF[chainId], name: CHAIN_NAME[chainId] }));
