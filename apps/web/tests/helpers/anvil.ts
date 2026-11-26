// Integration tests: start an anvil fork of Base mainnet at a pinned block.
// anvil comes from foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).
// The fork RPC is BASE_FORK_RPC_URL, else the public https://mainnet.base.org (publicnode did not
// resolve from the build machines). anvil caches fetched state in ~/.foundry/cache.
import { createServer } from "node:net";
import { createPublicClient, createTestClient, createWalletClient, http, type Chain } from "viem";
import { base } from "viem/chains";
import { launchAnvil } from "./anvil-proc";
import { forkPlanFor, startReplay } from "./fork-replay";

export const BASE_FORK_BLOCK = 57_172_000n;
export const BASE_FORK_RPC = process.env.BASE_FORK_RPC_URL ?? "https://mainnet.base.org";
/** The configured RPC first; when it is the default, other public endpoints take over if it errors. */
const baseUpstreams = () => (process.env.BASE_FORK_RPC_URL ? [BASE_FORK_RPC] : [BASE_FORK_RPC, "https://base.drpc.org", "https://1rpc.io/base"]);

/** anvil's well-known test keys (never real funds). */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

export type Fork = {
  rpcUrl: string;
  chain: Chain;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  stop: () => Promise<void>;
};

/** Start a Base fork. Call `stop()` in afterAll. Allow about 60 s for the first start. */
export async function startBaseFork(opts: { blockNumber?: bigint } = {}): Promise<Fork> {
  const port = await freePort();
  const block = opts.blockNumber ?? BASE_FORK_BLOCK;
  // anvil forks a local replay server, never the RPC directly (see fork-replay.ts, FORK_MODE).
  const plan = forkPlanFor(8453, block);
  const replay = await startReplay({ chainId: 8453, block, upstream: baseUpstreams(), mode: plan.mode, passthrough: plan.passthrough });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = { ...base, rpcUrls: { default: { http: [rpcUrl] } } } as Chain;
  const transport = http(rpcUrl, { timeout: 60_000 });
  const publicClient = createPublicClient({ chain, transport });
  const anvil = await launchAnvil(["--fork-url", replay.url, "--fork-block-number", String(block), "--no-storage-caching", "--port", String(port), "--chain-id", "8453"], replay, () => publicClient.getBlockNumber(), 60_000);
  return {
    rpcUrl,
    chain,
    publicClient,
    testClient: createTestClient({ chain, mode: "anvil", transport }),
    walletClient: createWalletClient({ chain, transport }),
    stop: () => anvil.stop(),
  };
}
