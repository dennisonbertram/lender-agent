// Fork replay modes: live mode must answer every read from the configured upstream, never from a stale snapshot;
// snapshot mode answers only from the file. Uses a bogus chain id and a local upstream: no external calls.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotFile, startReplay, type Replay } from "./fork-replay";

const CHAIN = 31337; // no committed snapshot uses this chain id
const BLOCK = 777n;
const FILE = snapshotFile(CHAIN, BLOCK);
const ADDR = "0x0000000000000000000000000000000000000bad"; // not an anvil dev account
const REQ = { jsonrpc: "2.0", id: 7, method: "eth_getBalance", params: [ADDR, "latest"] };
const KEY = `eth_getBalance${JSON.stringify(REQ.params)}`;
const STORED = "0x1111";
const LIVE = "0x2222";

const writeSnapshot = (store: Record<string, unknown>) => writeFileSync(FILE, gzipSync(JSON.stringify(store)));
const readSnapshot = () => JSON.parse(gunzipSync(readFileSync(FILE)).toString()) as Record<string, unknown>;
const post = async (url: string) =>
  (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(REQ) })).json()) as { result?: string; error?: unknown };

let upstream: Server;
let upstreamUrl = "";
let upstreamHits = 0;
const replays: Replay[] = [];
const replay = async (o: Parameters<typeof startReplay>[0]) => {
  const r = await startReplay(o);
  replays.push(r);
  return r;
};

beforeAll(async () => {
  if (existsSync(FILE)) rmSync(FILE);
  upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamHits++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: LIVE }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const a = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterAll(async () => {
  for (const r of replays) await r.stop().catch(() => {});
  await new Promise((r) => upstream.close(() => r(undefined)));
  if (existsSync(FILE)) rmSync(FILE);
});

describe("startReplay", () => {
  it("live mode asks the upstream even when the snapshot already has the answer", async () => {
    writeSnapshot({ [KEY]: STORED });
    upstreamHits = 0;
    const r = await replay({ chainId: CHAIN, block: BLOCK, upstream: upstreamUrl, mode: "live", record: false });
    expect((await post(r.url)).result).toBe(LIVE);
    expect(upstreamHits).toBe(1);
  });

  it("snapshot mode answers from the file and never calls upstream", async () => {
    writeSnapshot({ [KEY]: STORED });
    upstreamHits = 0;
    const r = await replay({ chainId: CHAIN, block: BLOCK, upstream: upstreamUrl, mode: "snapshot" });
    expect((await post(r.url)).result).toBe(STORED);
    expect(upstreamHits).toBe(0);
  });

  it("stop() resolves only after recorded live answers are written to the snapshot", async () => {
    if (existsSync(FILE)) rmSync(FILE);
    const r = await replay({ chainId: CHAIN, block: BLOCK, upstream: upstreamUrl, mode: "live" });
    await post(r.url);
    await r.stop();
    expect(readSnapshot()[KEY]).toBe(LIVE);
  });
});
