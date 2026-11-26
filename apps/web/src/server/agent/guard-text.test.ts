import { describe, expect, it } from "vitest";
import { guardText } from "./run";
import { SAFE_SENTENCE } from "./honesty";

async function run(chunks: object[]): Promise<string> {
  const t = guardText(() => {})() as unknown as TransformStream<object, { type: string; text?: string }>;
  const w = t.writable.getWriter();
  void (async () => { for (const c of chunks) await w.write(c); await w.close(); })();
  let out = "";
  const r = t.readable.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; if (value.type === "text-delta") out += value.text; }
  return out;
}
const text = (s: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", text: s }, { type: "text-end", id: "t" }];
const tool = (toolName: string) => ({ type: "tool-result", toolCallId: "c", toolName, input: {}, output: {} });

describe("guardText fallback depends on the card", () => {
  it.each([
    ["whatIf", "Here's what that fall would do to the loan."],
    ["showStatus", "Here's where your loan stands."],
    ["planLoan", "Here's a plan for that amount."],
    ["planEdit", "Here's a plan for that amount."],
    ["compareLenders", "Here are the lenders side by side."],
    ["showHoldings", "Here's what your Safe holds."],
  ])("%s", async (name, expected) => {
    expect(await run([tool(name), ...text("Your health factor would be 1.2")])).toBe(expected);
  });
  it("generic when there is no card", async () => {
    expect(await run(text("Your health factor would be 1.2"))).toBe(SAFE_SENTENCE);
  });
  it("clean text is untouched", async () => {
    expect(await run([tool("whatIf"), ...text("Here you go.")])).toBe("Here you go.");
  });
});
