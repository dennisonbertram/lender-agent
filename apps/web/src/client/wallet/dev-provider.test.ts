import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeInstallMockWallet } from "./dev-provider";

const REAL = { isRabby: true };
const setup = (ethereum?: unknown) => vi.stubGlobal("window", { ethereum, localStorage: { getItem: () => null } });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("maybeInstallMockWallet", () => {
  it("fork mode replaces an existing window.ethereum with the dev wallet", () => {
    vi.stubEnv("NEXT_PUBLIC_MOCK_WALLET", "1");
    vi.stubEnv("NEXT_PUBLIC_FORK_RPC_URL", "http://127.0.0.1:8645");
    setup(REAL);
    maybeInstallMockWallet();
    expect((window as unknown as { ethereum: { isDevWallet?: boolean } }).ethereum.isDevWallet).toBe(true);
  });
  it("mock mode keeps an existing window.ethereum", () => {
    vi.stubEnv("NEXT_PUBLIC_MOCK_WALLET", "1");
    vi.stubEnv("NEXT_PUBLIC_FORK_RPC_URL", "");
    setup(REAL);
    maybeInstallMockWallet();
    expect((window as unknown as { ethereum: unknown }).ethereum).toBe(REAL);
  });
  it("a remote fork URL does not count as fork mode", () => {
    vi.stubEnv("NEXT_PUBLIC_MOCK_WALLET", "1");
    vi.stubEnv("NEXT_PUBLIC_FORK_RPC_URL", "https://mainnet.base.org");
    vi.spyOn(console, "error").mockImplementation(() => {});
    setup(REAL);
    maybeInstallMockWallet();
    expect((window as unknown as { ethereum: unknown }).ethereum).toBe(REAL);
  });
});
