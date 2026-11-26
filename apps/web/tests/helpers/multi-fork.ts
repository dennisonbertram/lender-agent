// Anvil forks of any of the six Safe networks (M0-5). RPC: FORK_RPC_URL_<chainId>, else the first
// public endpoint that answers. BASE_FORK_RPC_URL is honoured for Base.
import { createServer } from "node:net";
import { createPublicClient, createTestClient, createWalletClient, http, type Chain, type PublicClient, type TestClient, type WalletClient } from "viem";
import { launchAnvil } from "./anvil-proc";
import { forkPlanFor, pinnedBlocks, recordPinnedBlock, startReplay } from "./fork-replay";
import { BASE_FORK_BLOCK } from "./anvil";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "viem/chains";

const CHAINS: Record<number, Chain> = { 1: mainnet, 8453: base, 42161: arbitrum, 10: optimism, 137: polygon, 100: gnosis };
const PUBLIC_RPCS: Record<number, string[]> = {
  1: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io/eth"],
  8453: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org", "https://1rpc.io/base"],
  42161: ["https://arb1.arbitrum.io/rpc"],
  10: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io", "https://optimism.drpc.org"],
  137: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  100: ["https://gnosis-rpc.publicnode.com", "https://rpc.gnosischain.com", "https://gnosis.drpc.org"],
};

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const a = srv.address();
    srv.close(() => (typeof a === "object" && a ? resolve(a.port) : reject(new Error("no port"))));
  });
});

async function answers(url: string, chainId: number): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(8_000) });
    return Number((await res.json() as { result?: string }).result) === chainId;
  } catch { return false; }
}

export async function forkSourceFor(chainId: number): Promise<string> {
  const env = process.env[`FORK_RPC_URL_${chainId}`] || (chainId === 8453 ? process.env.BASE_FORK_RPC_URL : undefined);
  const candidates = env ? [env] : PUBLIC_RPCS[chainId]!;
  for (let pass = 0; pass < 3; pass++) {
    for (const url of candidates) if (await answers(url, chainId)) return url;
    await new Promise((r) => setTimeout(r, 1_000 * (pass + 1)));
  }
  throw new Error(`No reachable RPC for chain ${chainId}; set FORK_RPC_URL_${chainId}`);
}

/** Public RPCs keep state for recent blocks only (Arbitrum: minutes), so a fixed old block number cannot be forked. Pin once at start, a little behind the head, so every read of the run sees the same block. */
const PIN_BEHIND = 20n;

async function headBlock(url: string, chainId: number): Promise<bigint> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(8_000) });
  return BigInt((await res.json() as { result: string }).result) - PIN_BEHIND;
}

export type ChainFork = { chainId: number; rpcUrl: string; chain: Chain; publicClient: PublicClient; walletClient: WalletClient; testClient: TestClient; mine: () => Promise<void>; stop: () => Promise<void> };

export async function startFork(chainId: number, opts: { blockNumber?: bigint } = {}): Promise<ChainFork> {
  // Fixed block per chain (fixtures/fork-snapshots/blocks.json). FORK_MODE=live with no fixed block pins a little behind the head.
  const envBlock = process.env[`FORK_BLOCK_${chainId}`];
  const fixed = opts.blockNumber ?? (envBlock ? BigInt(envBlock) : pinnedBlocks()[chainId] ?? (chainId === 8453 ? BASE_FORK_BLOCK : undefined));
  const plan = fixed === undefined ? { mode: "live" as const, passthrough: false } : forkPlanFor(chainId, fixed);
  const mode = plan.mode;
  let source = "";
  let pinned: bigint;
  if (mode === "snapshot") pinned = fixed!;
  else {
    source = await forkSourceFor(chainId);
    // Base keeps its fixed block (same as startBaseFork). Others: public RPCs serve recent state only, so take head-20;
    // `pnpm fork:snapshot` (FORK_UPDATE_BLOCKS=1) stores that block in blocks.json, and every test of that run reuses it.
    const refresh = process.env.FORK_UPDATE_BLOCKS === "1";
    pinned = (chainId === 8453 || refresh || opts.blockNumber || envBlock) && fixed !== undefined ? fixed : await headBlock(source, chainId);
    if (refresh && fixed === undefined) recordPinnedBlock(chainId, pinned);
  }
  const replay = await startReplay({ chainId, block: pinned, upstream: source, mode, record: process.env.FORK_UPDATE_BLOCKS === "1" || !!opts.blockNumber || !!envBlock, passthrough: plan.passthrough });
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = { ...CHAINS[chainId]!, rpcUrls: { default: { http: [rpcUrl] } } } as Chain;
  const transport = http(rpcUrl, { timeout: 60_000 });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const anvil = await launchAnvil(["--fork-url", replay.url, "--fork-block-number", String(pinned), "--no-storage-caching", "--port", String(port), "--chain-id", String(chainId)], replay, () => publicClient.getBlockNumber(), 90_000);
  const testClient = createTestClient({ chain, mode: "anvil", transport });
  return { chainId, rpcUrl, chain, publicClient, walletClient: createWalletClient({ chain, transport }), testClient, mine: () => testClient.mine({ blocks: 1 }), stop: () => anvil.stop() };
}
