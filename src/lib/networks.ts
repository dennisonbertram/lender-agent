import { NETWORKS, VENUES, ZERO_BALANCES, networkName, type Amounts, type Asset, type Network, type Safe, type SafeNetwork, type Stable, type Venue } from "@/data";
import { sampleAddress } from "@/lib/address";

/** Lenders available on a network. */
export const venuesOn = (network: Network) => VENUES.filter((v) => v.networks.includes(network));

/** Lenders the Safe can use with funds held on `from`: those on any network the Safe is set up on (funds can be moved there), plus `from` itself. */
export const lendersFor = (safe: Safe, from: Network, venues: Venue[] = VENUES) => venues.filter((v) => v.networks.includes(from) || safe.networks.some((n) => v.networks.includes(n.id)));

/** Lender names that are not on a network, for "not on Base" lines. */
export const venuesNotOn = (network: Network) => VENUES.filter((v) => !v.networks.includes(network));

/** "Ethereum", "Ethereum and Base", "Ethereum, Base and Arbitrum". */
export function networkList(ids: Network[]): string {
  const names = ids.map(networkName);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Up to three networks by name, otherwise "all 6 networks". */
export const networksLabel = (ids: Network[]) => (ids.length > 3 ? `all ${ids.length} networks` : networkList(ids));

/** The agent is on a Safe when it is a proposer on at least one network. */
export const deriveAgent = (networks: SafeNetwork[]) => networks.some((n) => n.agent);

const withNetworks = (safe: Safe, networks: SafeNetwork[]): Safe => ({ ...safe, networks, agent: deriveAgent(networks) });

/** True when the agent can propose on this network of the Safe. */
export const agentOn = (safe: Safe, network: Network) => !!safe.networks.find((n) => n.id === network)?.agent;

export const setNetworkAgent = (safe: Safe, network: Network, on: boolean): Safe =>
  withNetworks(safe, safe.networks.map((n) => (n.id === network ? { ...n, agent: on } : n)));

export const setAllAgents = (safe: Safe, on: boolean): Safe => withNetworks(safe, safe.networks.map((n) => ({ ...n, agent: on })));

/** The Safe is set up on a network the first time a transaction is made there. */
export const markDeployed = (safe: Safe, network: Network): Safe =>
  withNetworks(safe, safe.networks.map((n) => (n.id === network ? { ...n, deployed: true } : n)));

/** Adds a network to the Safe. The address does not change. No-op when the network is already there. */
export const addNetwork = (safe: Safe, network: Network, agent: boolean): Safe =>
  safe.networks.some((n) => n.id === network) ? safe : withNetworks(safe, [...safe.networks, { id: network, deployed: false, agent }]);

type Setup = { owners: string[]; threshold: number; salt: number };

/** Demo stand-in for Safe's address calculation: the same owners, threshold and salt give the same address, whatever the network. */
export function safeAddress({ owners, threshold, salt }: Setup): string {
  const text = `${owners.map((o) => o.toLowerCase()).join(",")}|${threshold}|${salt}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0;
  return sampleAddress(h);
}

/** A new Safe: one address, the chosen networks not yet set up, no agent, no funds. */
export function createSafe(p: Setup & { id: string; name: string; networks: Network[] }): Safe {
  return {
    id: p.id, name: p.name, address: safeAddress(p), threshold: `${p.threshold} of ${p.owners.length}`, agent: false,
    networks: p.networks.map((id) => ({ id, deployed: false, agent: false })), balances: {},
  };
}

export const balancesOn = (safe: Safe, network: Network): Amounts => safe.balances[network] ?? ZERO_BALANCES;

/** Sum over all networks. */
export function totalBalances(safe: Safe): Amounts {
  const t = { ...ZERO_BALANCES };
  for (const n of NETWORKS) for (const a of Object.keys(t) as (Asset | Stable)[]) t[a] += balancesOn(safe, n.id)[a];
  return t;
}

/** One group per network that holds something: its assets and the USD subtotal. */
export function balanceGroups(safe: Safe, prices: Record<Asset | Stable, number>) {
  return NETWORKS.flatMap(({ id }) => {
    const b = balancesOn(safe, id);
    const assets = (Object.keys(b) as (Asset | Stable)[]).filter((a) => b[a] > 0).map((asset) => ({ asset, amount: b[asset] }));
    return assets.length ? [{ network: id, assets, usd: assets.reduce((t, x) => t + x.amount * prices[x.asset], 0) }] : [];
  });
}

/** The Safe's balances after adding `amounts` on one network. */
export const deposit = (safe: Safe, network: Network, amounts: Partial<Amounts>): Safe => {
  const next = { ...balancesOn(safe, network) };
  for (const a of Object.keys(amounts) as (Asset | Stable)[]) next[a] += amounts[a] ?? 0;
  return { ...safe, balances: { ...safe.balances, [network]: next } };
};
