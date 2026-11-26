// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { delete (window as unknown as { ethereum?: unknown }).ethereum; vi.unstubAllEnvs(); vi.resetModules(); });
const load = async (url: string, localDemo = false) => {
  vi.stubEnv("NEXT_PUBLIC_FORK_RPC_URL", url);
  vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", localDemo ? "1" : "");
  vi.resetModules();
  return (await import("./config")).wagmiConfig;
};

describe("wagmiConfig in fork mode", () => {
  it("reads Base from the local fork", async () => {
    const cfg = await load("http://127.0.0.1:8645");
    expect(cfg.getClient({ chainId: 8453 }).transport.url).toBe("http://127.0.0.1:8645");
  });
  it("without a fork URL keeps discovery and the public Base transport", async () => {
    const cfg = await load("");
    expect(cfg.getClient({ chainId: 8453 }).transport.url).not.toContain("127.0.0.1");
  });
  it("local demo uses only its synthetic connector and loopback reads", async () => {
    const browserExtension = { isDevWallet: false };
    (window as unknown as { ethereum?: unknown }).ethereum = browserExtension;
    const cfg = await load("", true);
    expect(cfg.connectors.map((connector) => connector.id)).toEqual(["local-demo"]);
    expect(cfg.getClient({ chainId: 8453 }).transport.url).toBe("http://127.0.0.1:1");
    expect(cfg.getClient({ chainId: 42161 }).transport.url).toBe("http://127.0.0.1:1");
    expect((await cfg.connectors[0]!.getProvider() as { isDevWallet?: boolean }).isDevWallet).toBe(true);
    expect((window as unknown as { ethereum?: unknown }).ethereum).toBe(browserExtension);
  });
});
