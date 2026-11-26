// ChainFork.stop(): callers await it to know anvil exited, the replay server closed and fixture writes flushed.
// anvil itself is mocked, so the test needs no binary and no network; snapshot mode needs a (bogus) snapshot file.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { snapshotFile } from "./fork-replay";
import { startFork } from "./multi-fork";

const h = vi.hoisted(() => ({
  replay: undefined as { url: string; stop: () => Promise<void> } | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock("./anvil-proc", () => ({
  launchAnvil: async (_args: string[], replay: { url: string; stop: () => Promise<void> }) => {
    h.replay = replay;
    return { stop: () => new Promise<void>((resolve) => { h.release = resolve; }).then(() => replay.stop()) };
  },
}));

const FILE = snapshotFile(1, 999_999_999n); // a block no committed fixture uses

describe("ChainFork.stop", () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await h.replay?.stop().catch(() => {});
    if (existsSync(FILE)) rmSync(FILE);
  });

  it("returns and awaits the underlying teardown promise", async () => {
    vi.stubEnv("FORK_MODE", "snapshot");
    writeFileSync(FILE, gzipSync(JSON.stringify({ k: "v" }))); // snapshot mode needs a non-empty store
    const fork = await startFork(1, { blockNumber: 999_999_999n });

    const p = fork.stop();
    expect(p).toBeInstanceOf(Promise);
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // still gated on teardown: anvil exit, replay close, fixture write
    h.release!();
    await p;
    expect(settled).toBe(true);
    await expect(fetch(h.replay!.url, { method: "POST", body: "{}" })).rejects.toThrow(); // replay server is closed
  });
});
