import { describe, expect, it } from "vitest";
import { safeReturnTo, signInHref } from "./return-to";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";

describe("safeReturnTo", () => {
  it.each([
    "/..//evil.com",
    "/.//evil.com",
    "/a/..//evil.com",
    "/%2e%2e//evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "/\t/evil.com",
    "/api/x",
    "/api",
    "/api/auth/logout",
    "/",
    "",
    "/" + "a".repeat(600),
  ])("rejects %j", (raw) => {
    expect(safeReturnTo(raw)).toBeNull();
  });

  it("rejects missing values", () => {
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
  });

  it.each([`/s/${SAFE}/proposals/abc`, "/onboarding", "/s/0x1/proposals/7?x=1#a", "/%2F%2Fevil.com"])("keeps %s", (p) => {
    expect(safeReturnTo(p)).toBe(p);
  });

  it("never returns a protocol-relative or backslash result", () => {
    for (const raw of ["/..//evil.com", "/.//x", "/a/..//b", "/%2e%2e//x", "/a/../../b"]) {
      const out = safeReturnTo(raw);
      if (out) expect(out.startsWith("//") || out.startsWith("/\\")).toBe(false);
    }
  });
});

describe("signInHref", () => {
  it("encodes a safe path into ?next=", () => {
    expect(signInHref(`/s/${SAFE}/proposals/7`)).toBe(`/?next=${encodeURIComponent(`/s/${SAFE}/proposals/7`)}`);
  });
  it("falls back to / for unsafe paths", () => {
    expect(signInHref("//evil.com")).toBe("/");
    expect(signInHref("/..//evil.com")).toBe("/");
  });
});
