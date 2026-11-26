import { expect, it } from "vitest";
import { parseUsd } from "./loan-math";
import { usd } from "@/data";
import { depositLine, greetingText, starterChips } from "./blocks";

it("starterChips offers only what the Safe can do", () => {
  expect(starterChips(0)).toEqual(["Add funds", "How does this work?"]);
  expect(starterChips(0).some((c) => /\$|borrow|need/i.test(c))).toBe(false);
  expect(starterChips(7500)[0]).toBe("Borrow $7,500");
  for (const c of starterChips(7500)) expect(parseUsd(c) ?? 0).toBeLessThanOrEqual(7500);
});
it("greetingText reads the Safe", () => {
  expect(greetingText("My Safe", 1, 7500)).toContain("You can borrow up to $7,500");
  expect(greetingText("My Safe", 1, 7500)).not.toContain("co-signers");
  expect(greetingText("My Safe", 2, 7500)).toContain("you and your co-signers");
  expect(greetingText("My Safe", 1, 0)).toContain("is empty");
  expect(greetingText("My Safe", 1, 0)).not.toContain("them");
});
it("depositLine says what 5 ETH is worth and what it unlocks", () => {
  expect(depositLine("My Safe", "Base", 13725, 7500)).toBe(`I see 5 ETH (about ${usd(13725)}) on Base in My Safe. You can borrow up to ${usd(7500)} against it without selling it.`);
  expect(depositLine("My Safe", "Base", 13725, 0)).toBe(`I see 5 ETH (about ${usd(13725)}) on Base in My Safe. That is not enough to borrow against yet.`);
});
