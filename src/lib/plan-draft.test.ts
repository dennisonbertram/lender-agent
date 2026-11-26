import { expect, it } from "vitest";
import { cappedNote, isLivePlan, receiptLine, seedDraft } from "./plan-draft";
import { moveQuote } from "./cash-plan";

it("seedDraft copies the plan block into the draft", () => {
  expect(seedDraft({ kind: "plan", cash: 7500, asset: "ETH", network: "base" }, "m9")).toEqual({ text: "$7,500", hfIdx: 1, months: 12, asset: "ETH", network: "base", msgId: "m9" });
});
it("only the newest plan message is live", () => {
  expect(isLivePlan({ text: "", hfIdx: 1, months: 12, msgId: "m9" }, "m9")).toBe(true);
  expect(isLivePlan({ text: "", hfIdx: 1, months: 12, msgId: "m9" }, "m3")).toBe(false);
  expect(isLivePlan(undefined, "m3")).toBe(false);
});
it("receiptLine says what was sent", () => {
  const then = { kind: "open" as const, venueId: "compound", asset: "ETH" as const, amount: 4.86, borrow: 7500, safeId: "s", network: "ethereum" as const };
  expect(receiptLine({ kind: "move", safeId: "s", move: moveQuote("base", "ethereum", "ETH", 4.86), then }, "Compound v3")).toBe("Sent to your Safe: move 4.86 ETH to Ethereum, then borrow $7,500 from Compound v3.");
  expect(receiptLine({ ...then, venueId: "morpho" }, "Morpho Blue")).toBe("Sent to your Safe: borrow $7,500 from Morpho Blue, locking 4.86 ETH.");
});
it("seedDraft starts a plan above the maximum at the maximum", () => {
  expect(seedDraft({ kind: "plan", cash: 15000 }, "m1", 7500).text).toBe("$7,500");
  expect(seedDraft({ kind: "plan", cash: 5000 }, "m1", 7500).text).toBe("$5,000");
});
it("cappedNote shows only while the field still holds the cap", () => {
  expect(cappedNote(15000, 7500, 7500)).toBe("Capped at $7,500, the most this Safe can borrow.");
  expect(cappedNote(15000, 7500, 5000)).toBe("");
  expect(cappedNote(5000, 7500, 5000)).toBe("");
});
