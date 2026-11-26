// The Relayer: who sends the Safe deployment transaction (D-03). Anyone can send it (the factory is
// permissionless), so the relayer never holds an owner key (G2). Production is a stub that refuses.
import { createPublicClient, createWalletClient, http, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentCalldata } from "@/server/safe/setup";
import type { Address, SafeSetup } from "@/shared/types";

export interface Relayer {
  /** The sending address, or null when not configured. */
  readonly address: Address | null;
  /** Native balance in wei on a network. */
  balance(chainId: number): Promise<bigint>;
  /** Estimated cost in wei (gas estimate times the current fee) of deploying the setup. Throws when it would revert. */
  estimate(chainId: number, setup: SafeSetup): Promise<bigint>;
  /** Send `createProxyWithNonce` for the stored setup and wait for the receipt. Throws when it reverts. `costWei` is what it cost. */
  deploy(chainId: number, setup: SafeSetup): Promise<{ txHash: Hex; costWei: bigint }>;
}

export class RelayerNotConfigured extends Error {
  constructor() {
    super("not configured");
    this.name = "RelayerNotConfigured";
  }
}

/** Production placeholder: refuses every call until a funded, limited key is set up (D-03). */
export const stubRelayer: Relayer = {
  address: null,
  async balance() { throw new RelayerNotConfigured(); },
  async estimate() { throw new RelayerNotConfigured(); },
  async deploy() { throw new RelayerNotConfigured(); },
};

export type ChainClients = { publicClient: PublicClient; walletClient: WalletClient; chain: Chain };

/** Dev relayer: signs with one local key (an anvil key in tests) and sends through the given clients. */
export function createDevRelayer(p: { key: Hex; clientsFor: (chainId: number) => ChainClients }): Relayer {
  const account = privateKeyToAccount(p.key);
  return {
    address: account.address,
    async balance(chainId) {
      return p.clientsFor(chainId).publicClient.getBalance({ address: account.address });
    },
    async estimate(chainId, setup) {
      const { publicClient } = p.clientsFor(chainId);
      const [gas, fees] = await Promise.all([
        publicClient.estimateGas({ account, to: setup.factory, data: deploymentCalldata(setup) }),
        publicClient.estimateFeesPerGas(),
      ]);
      // Priority fee is inside maxFeePerGas; pad the gas a little for the gap between estimate and inclusion.
      return ((gas * 12n) / 10n) * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
    },
    async deploy(chainId, setup) {
      const { publicClient, walletClient, chain } = p.clientsFor(chainId);
      const txHash = await walletClient.sendTransaction({ account, chain, to: setup.factory, data: deploymentCalldata(setup) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("The deployment transaction reverted.");
      return { txHash, costWei: receipt.gasUsed * receipt.effectiveGasPrice };
    },
  };
}

const VIEM_CHAINS: Record<number, Chain> = { 1: mainnet, 8453: base, 42161: arbitrum, 10: optimism, 137: polygon, 100: gnosis };

/** viem clients for a supported network: `RPC_URL_<chainId>` or the chain's public default. */
export function envClients(chainId: number, env: Record<string, string | undefined> = process.env): ChainClients {
  const chain = VIEM_CHAINS[chainId];
  if (!chain) throw new Error(`Network ${chainId} is not supported.`);
  const transport = http(env[`RPC_URL_${chainId}`]?.split(",")[0]?.trim() || chain.rpcUrls.default.http[0]);
  return { chain, publicClient: createPublicClient({ chain, transport }) as PublicClient, walletClient: createWalletClient({ chain, transport }) };
}

/** `RELAYER=dev` with `DEV_RELAYER_KEY` (anvil keys only) gives the dev relayer; anything else is the refusing stub. */
export function relayerFromEnv(env: Record<string, string | undefined> = process.env): Relayer {
  if (env.RELAYER === "dev" && env.DEV_RELAYER_KEY) return createDevRelayer({ key: env.DEV_RELAYER_KEY as Hex, clientsFor: (id) => envClients(id, env) });
  return stubRelayer;
}
