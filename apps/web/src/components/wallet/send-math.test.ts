import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { checkAmount, isRejection, maxSendable } from "./send-math";
import { ETH_GAS_RESERVE, SEND_ASSETS } from "./tokens";

const [eth, wst] = SEND_ASSETS;
describe("send math", () => {
  it("Max keeps the gas reserve for ETH but not for tokens", () => {
    expect(maxSendable(eth, parseEther("1"))).toBe(parseEther("1") - ETH_GAS_RESERVE);
    expect(maxSendable(eth, parseEther("0.0001"))).toBe(0n);
    expect(maxSendable(wst, 5n)).toBe(5n);
  });
  it("parses with the token's decimals", () => {
    expect(checkAmount("0.25", eth, parseEther("1")).value).toBe(parseEther("0.25"));
    expect(checkAmount(".5", wst, parseEther("1")).value).toBe(parseEther("0.5"));
  });
  it("rejects zero, junk and too much", () => {
    expect(checkAmount("0", eth, parseEther("1")).error).toMatch(/above 0/);
    expect(checkAmount("abc", eth, parseEther("1")).error).toMatch(/number/);
    expect(checkAmount("2", wst, parseEther("1")).error).toMatch(/only have 1 wstETH/);
    expect(checkAmount("1", eth, parseEther("1")).error).toMatch(/network fee/);
    expect(checkAmount("", eth, 1n)).toEqual({});
  });
  it("recognises a rejected request", () => {
    expect(isRejection({ name: "UserRejectedRequestError" })).toBe(true);
    expect(isRejection({ code: 4001 })).toBe(true);
    expect(isRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isRejection(new Error("boom"))).toBe(false);
  });
});
