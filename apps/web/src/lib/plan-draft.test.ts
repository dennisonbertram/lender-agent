import { expect, it } from "vitest";
import { NETWORKS } from "../../tests/fixtures/legacy-data";
import { cappedNote, isLivePlan, receiptLine, seedDraft } from "./plan-draft";

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
  const move = { from: "base" as const, to: "ethereum" as const, asset: "ETH" as const, amount: 4.86, feeUsd: 37, minutes: 91 };
  expect(receiptLine({ kind: "move", safeId: "s", move, then }, "Compound v3", NETWORKS)).toBe("Sent to your Safe: move 4.86 ETH to Ethereum, then borrow $7,500 from Compound v3.");
  expect(receiptLine({ ...then, venueId: "morpho" }, "Morpho Blue", NETWORKS)).toBe("Sent to your Safe: borrow $7,500 from Morpho Blue, locking 4.86 ETH.");
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
it("cappedNote says a request under the minimum starts at the minimum, until the field is edited", () => {
  expect(cappedNote(5, 3500, 10)).toBe("The smallest loan is $10, so this plan starts there.");
  expect(cappedNote(5, 3500, 600)).toBe("");
  expect(cappedNote(5, 3500, 100, 100)).toBe("The smallest loan is $100, so this plan starts there.");
});
