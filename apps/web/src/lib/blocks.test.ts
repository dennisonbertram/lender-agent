import { expect, it } from "vitest";
import { parseUsd } from "./loan-math";
import { usd } from "@/lib/format";
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
  expect(greetingText("My Safe", 1, 0)).toContain("Your Safe is empty");
  expect(greetingText("Family", 1, 0)).toContain('Your Safe "Family" is empty');
  expect(greetingText("My Safe", 1, 0)).not.toContain("them");
});
it("depositLine says what was deposited and what it unlocks", () => {
  expect(depositLine("My Safe", "Base", "ETH", 5, 13725, 7500)).toBe(`I see 5 ETH (about ${usd(13725)}) on Base in My Safe. You can borrow up to ${usd(7500)} against it without selling it.`);
  expect(depositLine("My Safe", "Base", "ETH", 5, 13725, 0)).toBe(`I see 5 ETH (about ${usd(13725)}) on Base in My Safe. That is not enough to borrow against yet.`);
});

it("no borrowing chip while a loan is at risk", () => {
  expect(starterChips(3500, { lender: "Aave v3", loanId: "L1" })).toEqual(["Fix my Aave v3 loan", "How does this work?"]);
  expect(starterChips(0, { lender: "Aave v3", loanId: "L1" }).some((c) => /borrow|get cash|compare|add funds/i.test(c))).toBe(false);
  expect(greetingText("My Safe", 1, 3500, { lender: "Aave v3", loanId: "L1" })).toContain("One of your loans needs attention first.");
  expect(greetingText("My Safe", 1, 3500, { lender: "Aave v3", loanId: "L1" })).not.toMatch(/borrow up to/i);
  expect(greetingText("My Safe", 2, 3500, { lender: "Aave v3", loanId: "L1" })).toContain("you and your co-signers");
});
