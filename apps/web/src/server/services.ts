// The service container. Real services by default; `MOCK=1` swaps in the fixture chain reader,
// the in-process fake Safe Transaction Service and a dev proposer key, all seeded with the mock
// world in `mock/seed.ts`. Owner: the coordinator. Tests replace it with `setServicesForTests`.
import { createAccess, type Access } from "@/server/auth/access";
import { safeAbi } from "@/server/chain/abis";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { createViemReader, type ChainReader } from "@/server/chain/reader";
import { createFixtureLenders } from "@/server/lenders/fixture";
import { chainLenderReads, type LenderReads } from "@/server/lenders/reads";
import { getDb, type Db } from "@/server/db/client";
import { FakeSafeService } from "@/server/safe/fake-service";
import { SafeServiceClient, type SafeService } from "@/server/safe/service-client";
import { getSigner, type Signer } from "@/server/signer";
import { MOCK_AGENT_KEY, seedMockWorld } from "@/server/mock/seed";
import { SAFE_CHAIN_IDS } from "@/lib/safe-create";
import { envClients } from "@/server/safe-create/relayer";
import { chainTestRunDeps, type TestRunDeps } from "@/server/proposals/test-run";
import { chainExecDeps, type ExecDeps } from "@/server/proposals/exec-deps";
import { mockSimulate } from "@/server/simulate/mock";
import { isChainId, type Address, type ChainId } from "@/shared/types";

export type Services = {
  mock: boolean;
  /** FORK=1: real reads and execution over a local anvil fork, with the in-memory Safe Transaction Service. */
  fork?: boolean;
  db: () => Promise<Db>;
  reader: ChainReader;
  safeService: (chainId: ChainId) => SafeService;
  signer: Signer;
  access: Access;
  /** Compound and Morpho reads for the quote (Aave is read through `reader`). Absent: Aave only. */
  lenders?: LenderReads;
  /** Nonce read and simulation for `testRun(p, services.testRunDeps)` (BP-13). */
  testRunDeps: TestRunDeps;
  /** Simulation, gas price and tx lookup for an owner's execution. Absent: real chain (mock mode: canned). */
  execDeps?: ExecDeps;
  /** Present in mock mode and in tests: mutate chain state. */
  fixture?: FixtureReader;
  /** Present in mock mode and in tests: the fake Transaction Service per chain. */
  fakes?: Map<ChainId, FakeSafeService>;
};

export const isMock = (env: Record<string, string | undefined> = process.env) => env.MOCK === "1";

/** FORK=1 with MOCK=1 is a contradiction, not a silent fallback to mock. */
export const isFork = (env: Record<string, string | undefined> = process.env) => {
  if (env.FORK === "1" && env.MOCK === "1") throw new Error("FORK=1 and MOCK=1 are both set; pick one (fork mode runs on a local anvil, mock mode on fixtures).");
  return env.FORK === "1";
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Fork mode may never run in production or against a remote RPC: it fakes the Safe service and trusts dev keys. */
export function assertForkEnv(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === "production") throw new Error("FORK=1 is refused in production.");
  const urls = (env.RPC_URL_8453 ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const local = urls.length > 0 && urls.every((u) => { try { return LOCAL_HOSTS.has(new URL(u).hostname); } catch { return false; } });
  if (!local) throw new Error("FORK=1 needs RPC_URL_8453 to be a localhost URL (the local anvil fork).");
}

type Fetch = typeof fetch;

/** The fork RPC must be anvil itself (`web3_clientVersion` contains "anvil"), not a real local Base node. Async, so it runs on first fork-service use. */
export async function assertAnvil(env: Record<string, string | undefined> = process.env, fetchFn: Fetch = fetch): Promise<void> {
  for (const url of (env.RPC_URL_8453 ?? "").split(",").map((u) => u.trim()).filter(Boolean)) {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) });
    const version = ((await res.json().catch(() => null)) as { result?: unknown } | null)?.result;
    if (typeof version !== "string" || !/anvil/i.test(version)) throw new Error(`FORK=1 needs RPC_URL_8453 to be anvil; ${url} reports ${JSON.stringify(version ?? null)}.`);
  }
}

/** The networks the app tracks in M1 (D-16). Base Sepolia is for live checks only. */
export const M1_CHAIN_ID: ChainId = 8453;

/** Reads current owners on any network offered by the Safe setup flow, including setup-only networks. */
async function readSetupOwners(reader: ChainReader, chainId: number, address: Address): Promise<Address[] | null> {
  if (!SAFE_CHAIN_IDS.includes(chainId)) return null;
  if (isChainId(chainId)) return reader.readSafeOwners(chainId, address);
  const client = envClients(chainId).publicClient;
  const code = await client.getCode({ address });
  if (!code || code === "0x" || code.toLowerCase().startsWith("0xef0100")) return null;
  return [...await client.readContract({ address, abi: safeAbi, functionName: "getOwners" })] as Address[];
}

export function createMockServices(opts: { db?: () => Promise<Db> } = {}): Services {
  const fixture = createFixtureReader();
  const fakes = new Map<ChainId, FakeSafeService>([[8453, new FakeSafeService(8453)], [84532, new FakeSafeService(84532)], [42161, new FakeSafeService(42161)]]);
  seedMockWorld(fixture, fakes.get(8453)!);
  return {
    mock: true,
    db: opts.db ?? getDb,
    reader: fixture,
    safeService: (chainId) => fakes.get(chainId)!,
    signer: getSigner({ PROPOSER_SIGNER: "dev", DEV_PROPOSER_KEY: process.env.DEV_PROPOSER_KEY || MOCK_AGENT_KEY }, opts.db ?? getDb),
    access: createAccess({
      readOwners: fixture.readSafeOwners,
      readSetupOwners: async (chainId, address) => isChainId(chainId) ? fixture.readSafeOwners(chainId, address) : null,
      isIndexed: async (chainId, address) => (await fakes.get(chainId)!.getSafe(address)) !== null,
    }),
    testRunDeps: { readNonce: fixture.readSafeNonce, simulate: mockSimulate(fixture) },
    lenders: createFixtureLenders(),
    fixture,
    fakes,
  };
}

function createRealServices(): Services {
  const reader = createViemReader();
  const clients = new Map<ChainId, SafeService>();
  return {
    mock: false,
    db: getDb,
    reader,
    safeService: (chainId) => {
      if (!clients.has(chainId)) clients.set(chainId, SafeServiceClient.forChain(chainId));
      return clients.get(chainId)!;
    },
    signer: getSigner(),
    access: createAccess({
      readOwners: reader.readSafeOwners,
      readSetupOwners: (chainId, address) => readSetupOwners(reader, chainId, address),
      isIndexed: async (chainId, address) => {
        if (!clients.has(chainId)) clients.set(chainId, SafeServiceClient.forChain(chainId));
        return (await clients.get(chainId)!.getSafe(address)) !== null;
      },
    }),
    testRunDeps: chainTestRunDeps,
    lenders: chainLenderReads,
  };
}

/** Fork world: the chain is a local anvil copy of Base. Only the Safe Transaction Service is faked; the Safes come from `FORK_SAFES` (JSON `[{address, owners, threshold}]`). */
export function createForkServices(env: Record<string, string | undefined> = process.env, deps: { fetch?: Fetch } = {}): Services {
  assertForkEnv(env);
  // createForkServices is sync, so the anvil check runs once, on first use of the database (every request and worker tick starts there).
  let anvil: Promise<void> | undefined;
  const checkedDb = async () => { await (anvil ??= assertAnvil(env, deps.fetch).catch((e) => { anvil = undefined; throw e; })); return getDb(); };
  const reader = createViemReader();
  const fakes = new Map<ChainId, FakeSafeService>([[8453, new FakeSafeService(8453)]]);
  for (const s of JSON.parse(env.FORK_SAFES || "[]") as { address: Address; owners: Address[]; threshold: number }[]) fakes.get(8453)!.setOwners(s.address, s.owners, s.threshold);
  return {
    mock: false,
    fork: true,
    db: checkedDb,
    reader,
    safeService: (chainId) => {
      const f = fakes.get(chainId);
      if (!f) throw new Error(`Fork mode serves Base (8453) only, not ${chainId}.`);
      return f;
    },
    signer: getSigner({ PROPOSER_SIGNER: "dev", DEV_PROPOSER_KEY: env.DEV_PROPOSER_KEY ?? MOCK_AGENT_KEY }, getDb),
    access: createAccess({
      readOwners: reader.readSafeOwners,
      readSetupOwners: async (chainId, address) => chainId === 8453 ? reader.readSafeOwners(8453, address) : null,
      isIndexed: async (chainId, address) => (await fakes.get(chainId)!.getSafe(address)) !== null,
    }),
    testRunDeps: chainTestRunDeps,
    execDeps: chainExecDeps,
    lenders: chainLenderReads,
    fakes,
  };
}

export function selectServices(env: Record<string, string | undefined> = process.env): Services {
  const fork = isFork(env); // throws on FORK=1 with MOCK=1
  return fork ? createForkServices(env) : isMock(env) ? createMockServices() : createRealServices();
}

const g = globalThis as unknown as { __lenderServices?: Services };

export function getServices(): Services {
  g.__lenderServices ??= selectServices();
  return g.__lenderServices;
}

/** Tests only. */
export function setServicesForTests(s: Services | undefined) {
  g.__lenderServices = s;
}
