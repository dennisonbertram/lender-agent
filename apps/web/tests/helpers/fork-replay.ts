// Deterministic fork source for anvil. A tiny local JSON-RPC server that anvil uses as its --fork-url.
//   FORK_MODE=snapshot  answers only from tests/fixtures/fork-snapshots/<chain>-<block>.json.gz (no network).
//   FORK_MODE=live      forwards to the real RPC and records every answer into that file (refresh).
// A request is keyed by method + params, so the same EVM execution always gets the same answers.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export type ForkMode = "snapshot" | "live";
type Rpc = { id?: unknown; method: string; params?: unknown[] };
type Store = Record<string, unknown>;

const DIR = path.join(import.meta.dirname, "..", "fixtures", "fork-snapshots");
export const snapshotFile = (chainId: number, block: bigint | number) => path.join(DIR, `${chainId}-${block}.json.gz`);
const BLOCKS = path.join(DIR, "blocks.json");
/** The fixed block per chain id that fork tests pin to. */
export const pinnedBlocks = (): Record<number, bigint> =>
  existsSync(BLOCKS) ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(BLOCKS, "utf8")) as Record<string, string>).map(([k, v]) => [Number(k), BigInt(v)])) : {};
export function recordPinnedBlock(chainId: number, block: bigint) {
  const cur = existsSync(BLOCKS) ? (JSON.parse(readFileSync(BLOCKS, "utf8")) as Record<string, string>) : {};
  cur[String(chainId)] = String(block);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(BLOCKS, JSON.stringify(cur, null, 2) + "\n");
}
export const hasSnapshot = (chainId: number, block: bigint | number) => existsSync(snapshotFile(chainId, block));

/** FORK_MODE wins; else snapshot when one exists for this chain/block, else live. */
export function forkModeFor(chainId: number, block: bigint | number): ForkMode {
  return forkPlanFor(chainId, block).mode;
}

/** Mode plus whether live answers are recorded/seeded from the committed file. Only an explicit FORK_MODE=live (refresh) records; the automatic live fallback is a plain pass-through so it neither pollutes nor is masked by the snapshot. */
export function forkPlanFor(chainId: number, block: bigint | number): { mode: ForkMode; passthrough: boolean } {
  const m = process.env.FORK_MODE;
  if (m === "live") return { mode: "live", passthrough: false };
  if (m === "snapshot") return { mode: "snapshot", passthrough: false };
  if (m) throw new Error(`FORK_MODE must be "snapshot" or "live", got "${m}"`);
  if (!hasSnapshot(chainId, block)) return { mode: "live", passthrough: true };
  // Snapshots record the requests one anvil version makes; another version asks for things that were never recorded.
  if (localAnvilVersion() !== SNAPSHOT_ANVIL) {
    if (!warned) console.warn(`[fork] anvil ${localAnvilVersion() ?? "?"} is not ${SNAPSHOT_ANVIL}, the version the snapshots were recorded with: using live RPCs. Run \`foundryup -i v${SNAPSHOT_ANVIL}\` for offline runs.`);
    warned = true;
    return { mode: "live", passthrough: true };
  }
  return { mode: "snapshot", passthrough: false };
}

/** The anvil version the committed snapshots were recorded with (CI pins the same Foundry version in .github/workflows/ci.yml). */
export const SNAPSHOT_ANVIL = "1.9.0";
/** The anvil the helpers spawn: ~/.foundry/bin first, else PATH. */
export const anvilBinary = () => {
  const local = path.join(os.homedir(), ".foundry", "bin", "anvil");
  return existsSync(local) ? local : "anvil";
};
let warned = false;
let anvilVersion: string | null | undefined;
function localAnvilVersion(): string | null {
  if (anvilVersion === undefined) {
    try { anvilVersion = /(\d+\.\d+\.\d+)/.exec(execFileSync(anvilBinary(), ["--version"], { encoding: "utf8" }))?.[1] ?? null; } catch { anvilVersion = null; }
  }
  return anvilVersion;
}

const BEACON_ROOTS = "0x000f3df6d732807ef1319fb7b8bb8522d0beac02";
const ANVIL_DEV = new Set([
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906", "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65", "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9", "0x14dc79964da2c08b23698b3d3cc7ca32193d9955", "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
]);
const keyOf = (r: Rpc) => `${r.method}${JSON.stringify(r.params ?? [])}`;
const load = (file: string): Store => (existsSync(file) ? JSON.parse(gunzipSync(readFileSync(file)).toString()) : {});

export type Replay = { url: string; mode: ForkMode; stop: () => Promise<void> };

export async function startReplay(o: { chainId: number; block: bigint; upstream?: string | string[]; mode: ForkMode; record?: boolean; passthrough?: boolean }): Promise<Replay> {
  const file = snapshotFile(o.chainId, o.block);
  // Only snapshot mode answers from the file. Live mode starts empty so every read reaches a configured upstream;
  // on a refresh run the recorded fresh answers are merged over the file at stop().
  const store: Store = o.mode === "snapshot" ? load(file) : {};
  const upstreams = [o.upstream ?? []].flat();
  if (o.mode === "snapshot" && Object.keys(store).length === 0) throw new Error(`No fork snapshot ${file}; run \`pnpm fork:snapshot\` (or FORK_MODE=live)`);
  if (o.mode === "live" && upstreams.length === 0) throw new Error("live fork mode needs an upstream RPC");
  const fresh: Store = {};

  const answer = async (r: Rpc): Promise<unknown> => {
    const k = keyOf(r);
    // anvil's own dev accounts: on real chains they carry EIP-7702 delegations (sweeper bots), a nonce and dust, which breaks
    // tests that use them (e.g. Aave borrow reverts). Which of them anvil asks about at startup also differs by version.
    // Tests fund them with anvil_setBalance. Answered the same in every mode, live included.
    if (ANVIL_DEV.has(String(r.params?.[0]).toLowerCase())) {
      if (r.method === "eth_getTransactionCount" || r.method === "eth_getBalance") return { jsonrpc: "2.0", id: r.id, result: "0x0" };
      if (r.method === "eth_getCode") return { jsonrpc: "2.0", id: r.id, result: "0x" };
      if (r.method === "eth_getAccountInfo") return { jsonrpc: "2.0", id: r.id, result: { balance: "0x0", nonce: "0x0", code: "0x" } }; // anvil 1.7 asks for all three at once
    }
    if (k in store) return { jsonrpc: "2.0", id: r.id, result: store[k] };
    if (o.mode === "snapshot") {
      // Things that depend on this run's wall clock or nonces, not on the chain at the fork block.
      if (r.method === "eth_getTransactionReceipt" || r.method === "eth_getTransactionByHash") return { jsonrpc: "2.0", id: r.id, result: null }; // a hash that is not on the chain yet
      if (r.method === "eth_getStorageAt" && String(r.params?.[0]).toLowerCase() === BEACON_ROOTS) return { jsonrpc: "2.0", id: r.id, result: `0x${"0".repeat(64)}` }; // slot = timestamp % 8191
    }
    if (o.mode === "snapshot") return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: `fork snapshot miss: ${k.slice(0, 200)}` } };
    // Free RPCs fail now and then (rate limits, 5xx): retry, rotating through the candidate upstreams.
    const MAX = 6;
    let last: unknown = { code: -32000, message: "upstream error" };
    for (let attempt = 0; attempt < MAX; attempt++) {
      const url = upstreams[attempt % upstreams.length]!;
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: r.method, params: r.params ?? [] }), signal: AbortSignal.timeout(30_000) });
        const j = (await res.json()) as { result?: unknown; error?: unknown };
        if (j.result !== undefined) { store[k] = fresh[k] = j.result; return { jsonrpc: "2.0", id: r.id, result: j.result }; }
        last = j.error ?? { code: -32000, message: `upstream error (HTTP ${res.status}) at ${new URL(url).host} for ${k.slice(0, 100)}` };
      } catch (e) {
        last = { code: -32000, message: `upstream failed at ${new URL(url).host}: ${String(e)}` };
      }
      await new Promise((r2) => setTimeout(r2, 400 * (attempt + 1)));
    }
    return { jsonrpc: "2.0", id: r.id, error: last };
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Rpc | Rpc[];
        const out = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400).end(String(e));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  return {
    url,
    mode: o.mode,
    stop: async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
      if (o.mode === "live" && o.record !== false && !o.passthrough && Object.keys(fresh).length > 0) {
        // Merge with what other test files recorded meanwhile, then replace atomically.
        const merged = { ...load(file), ...store };
        mkdirSync(DIR, { recursive: true });
        const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, gzipSync(JSON.stringify(sorted), { level: 9 }));
        renameSync(tmp, file);
      }
    },
  };
}
