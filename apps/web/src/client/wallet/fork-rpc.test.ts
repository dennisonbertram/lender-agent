import { afterEach, describe, expect, it, vi } from "vitest";
import { forkRpcUrl, resetForkRpcWarning } from "./fork-rpc";

afterEach(() => { vi.restoreAllMocks(); resetForkRpcWarning(); });

describe("forkRpcUrl", () => {
  it.each(["http://localhost:8645", "http://127.0.0.1:8645", "http://[::1]:8645"])("accepts %s", (u) => {
    expect(forkRpcUrl(u, "development")).toBe(u);
  });
  it("returns null when unset, without complaining", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(forkRpcUrl("", "development")).toBeNull();
    expect(forkRpcUrl(undefined, "development")).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });
  it.each(["https://mainnet.base.org", "http://127.0.0.1.evil.com:8645", "not a url"])("rejects %s and logs once", (u) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(forkRpcUrl(u, "development")).toBeNull();
    expect(forkRpcUrl(u, "development")).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
  });
  it("rejects a localhost URL in production", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(forkRpcUrl("http://127.0.0.1:8645", "production")).toBeNull();
  });
});
