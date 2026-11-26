import { describe, expect, it } from "vitest";
import { blockSchema, parseBlock } from "./block-schema";

const valid = [
  { kind: "plan", cash: 12000 },
  { kind: "plan", cash: 5000, asset: "wstETH", network: "base", venueId: "aave-v3", hfIdx: 1, months: 12 },
  { kind: "compare", cash: 7500, asset: "ETH", network: "base" },
  { kind: "whatif" },
  { kind: "whatif", asset: "ETH", cash: 10000 },
  { kind: "whatif", asset: "ETH", drop: 30 },
  { kind: "whatif", drop: 60, capped: true },
  { kind: "explain", topic: "how" },
  { kind: "explain", topic: "reserve" },
  { kind: "status" },
  { kind: "fix", loanId: "8453:0x5afe5afe5afe5afe5afe5afe5afe5afe5afe0001:aave-v3" },
  { kind: "holdings" },
  { kind: "addfunds" },
  { kind: "suggestions", items: ["Add funds", "How does this work?"] },
];

describe("block schema", () => {
  it.each(valid)("parses %j", (b) => {
    expect(parseBlock(b)).toEqual(b);
  });
  it("covers every UIBlock kind", () => {
    expect(new Set(valid.map((b) => b.kind))).toEqual(new Set(blockSchema.options.map((o) => o.shape.kind.value)));
  });
  it.each([
    [{ kind: "chart" }],
    [{}],
    [{ kind: "plan" }],
    [{ kind: "plan", cash: "12000" }],
    [{ kind: "plan", cash: 100, asset: "DOGE" }],
    [{ kind: "plan", cash: 100, months: 5 }],
    [{ kind: "explain" }],
    [{ kind: "explain", topic: "gas" }],
    [{ kind: "suggestions" }],
    [{ kind: "suggestions", items: [] }],
    [{ kind: "compare", asset: "ETH" }],
    [{ kind: "whatif", drop: 101 }],
    [{ kind: "whatif", drop: 2.5 }],
    [null],
    ["plan"],
  ])("rejects %j", (b) => {
    expect(() => parseBlock(b)).toThrow();
  });
});
