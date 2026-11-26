// Wire `SetupDeps` from the service container: real chains and Transaction Service, or the MOCK=1 world.
import type { Db } from "@/server/db/client";
import { getPublicClient } from "@/server/chain/client";
import { safeAbi } from "@/server/chain/abis";
import { predictSafeAddress } from "@/server/safe/setup";
import type { Services } from "@/server/services";
import { isChainId, type Address } from "@/shared/types";
import { envClients, relayerFromEnv, type Relayer } from "./relayer";
import { budgetFromEnv } from "./sponsorship";
import type { SetupDeps } from "./setup";

/** MOCK=1 relayer: "deploys" by marking the Safe present in the fixture chain and the fake Transaction Service. */
function mockRelayer(services: Services): Relayer {
  return {
    address: "0x000000000000000000000000000000000000dEaD",
    balance: async () => 10n ** 18n,
    estimate: async () => 1_000_000_000n,
    async deploy(chainId, setup) {
      if (!isChainId(chainId) || !services.fixture) throw new Error("This network is not available yet.");
      const safe = predictSafeAddress(setup);
      services.fixture.setOwners(chainId, safe, setup.owners, setup.threshold);
      services.fakes?.get(chainId)?.setOwners(safe, setup.owners, setup.threshold);
      return { txHash: "0x00000000000000000000000000000000000000000000000000000000000000d1", costWei: 0n };
    },
  };
}

export function setupDepsFor(services: Services, db: Db, env: Record<string, string | undefined> = process.env): SetupDeps {
  const budget = budgetFromEnv(env);
  if (services.mock) {
    return {
      db, budget, relayer: mockRelayer(services),
      hasCode: async (chainId, a: Address) => isChainId(chainId) && services.reader.isDeployed(chainId, a),
      getLiveSetup: async (chainId, a: Address) => {
        if (!isChainId(chainId)) return null;
        const [owners, threshold] = await Promise.all([services.reader.readSafeOwners(chainId, a), services.reader.readSafeThreshold(chainId, a)]);
        return owners && threshold !== null ? { owners, threshold } : null;
      },
      receiptStatus: async () => "pending",
      isIndexed: async (chainId, a) => isChainId(chainId) && (await services.safeService(chainId).getSafe(a)) !== null,
    };
  }
  return {
    db, budget, relayer: relayerFromEnv(env),
    hasCode: async (chainId, a) => {
      const client = isChainId(chainId) ? getPublicClient(chainId) : envClients(chainId, env).publicClient;
      const code = await client.getCode({ address: a });
      return !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");
    },
    getLiveSetup: async (chainId, a: Address) => {
      const client = isChainId(chainId) ? getPublicClient(chainId) : envClients(chainId, env).publicClient;
      try {
        const [owners, threshold] = await Promise.all([
          client.readContract({ address: a, abi: safeAbi, functionName: "getOwners" }),
          client.readContract({ address: a, abi: safeAbi, functionName: "getThreshold" }),
        ]);
        return { owners: [...owners], threshold: Number(threshold) };
      } catch (e) {
        const code = await client.getCode({ address: a }).catch(() => null);
        if (!code || code === "0x" || code.toLowerCase().startsWith("0xef0100")) return null;
        throw e;
      }
    },
    receiptStatus: async (chainId, hash) => {
      const client = isChainId(chainId) ? getPublicClient(chainId) : envClients(chainId, env).publicClient;
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return receipt.status === "success" ? "success" : "reverted";
      } catch {
        // A missing receipt and a temporary RPC failure are both unresolved; never turn them into a fee prompt.
        return "pending";
      }
    },
    // Networks the app does not read have no Transaction Service mapping: the Safe being on chain is enough there.
    isIndexed: async (chainId, a) => !isChainId(chainId) || (await services.safeService(chainId).getSafe(a)) !== null,
  };
}
