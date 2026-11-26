import { describe, expect, it } from "vitest";
import { chatTools, TOOL_OF_KIND } from "./tools";

describe("suggest tool", () => {
  const run = (items: string[]) => (chatTools.suggest.execute as (i: { items: string[] }, o: unknown) => Promise<unknown>)({ items }, { toolCallId: "t", messages: [] });
  it("keeps safe chips", async () => {
    expect(await run(["Show my loans", "Borrow $5,000"])).toEqual({ kind: "suggestions", items: ["Show my loans"] });
  });
  it("returns an empty result, not an error, when every chip is dropped", async () => {
    await expect(run(["Borrow $5,000", "Show two loans"])).resolves.toBeNull();
  });
});

describe("compareLenders and whatIf tools", () => {
  const call = (name: "compareLenders" | "whatIf", input: unknown) => (chatTools[name].execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: "t", messages: [] });
  it("compareLenders returns a compare block with only the parameters", async () => {
    expect(await call("compareLenders", { cash: 7500, asset: "ETH", network: "base" })).toEqual({ kind: "compare", cash: 7500, asset: "ETH", network: "base" });
    expect(await call("compareLenders", { cash: 5000 })).toEqual({ kind: "compare", cash: 5000 });
  });
  it("whatIf snaps the asked fall to a slider step and flags one above the range", async () => {
    expect(await call("whatIf", { asset: "ETH", drop: 33 })).toEqual({ kind: "whatif", asset: "ETH", drop: 35 });
    expect(await call("whatIf", { drop: 80 })).toEqual({ kind: "whatif", drop: 60, capped: true });
  });
  it("whatIf returns a whatif block", async () => {
    expect(await call("whatIf", {})).toEqual({ kind: "whatif" });
    expect(await call("whatIf", { asset: "WBTC", cash: 10000 })).toEqual({ kind: "whatif", asset: "WBTC", cash: 10000 });
  });
  it("maps each block kind back to its tool", () => {
    expect(TOOL_OF_KIND.compare).toBe("compareLenders");
    expect(TOOL_OF_KIND.whatif).toBe("whatIf");
  });
});

describe("planEdit tool (BP-24)", () => {
  const call = (input: unknown) => (chatTools.planEdit.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: "t", messages: [] });
  it("returns an edit plan block with only the parameters", async () => {
    expect(await call({ cash: 3000 })).toEqual({ kind: "plan", cash: 3000, edit: true });
    expect(await call({ cash: 3000, asset: "WBTC", network: "base" })).toEqual({ kind: "plan", cash: 3000, edit: true, asset: "WBTC", network: "base" });
  });
});

describe("scripted model: fix my loan", () => {
  it("replies with the fix block's tool for the urgent loan, not a plan", async () => {
    const { scriptedReply } = await import("./model");
    const r = scriptedReply("Fix my Aave v3 loan", 7500, { lender: "Aave v3", loanId: "L1" });
    expect(r.tool).toEqual({ name: "showFix", input: { loanId: "L1" } });
    const out = await (chatTools.showFix.execute as (i: unknown, o: unknown) => Promise<unknown>)(r.tool!.input, { toolCallId: "t", messages: [] });
    expect(out).toEqual({ kind: "fix", loanId: "L1" });
    expect(TOOL_OF_KIND.fix).toBe("showFix");
  });
});

describe("scripted model: loan-aware (R1, F-01, F-04)", () => {
  it("with an open loan, 'How is my loan doing?' calls showStatus, not a plan", async () => {
    const { scriptedReply } = await import("./model");
    expect(scriptedReply("How is my loan doing?", 7500, undefined, { hasLoan: true }).tool).toEqual({ name: "showStatus", input: {} });
    expect(scriptedReply("Can I borrow $500 more?", 7500, undefined, { hasLoan: true }).text).toMatch(/adds to your existing loan/);
  });
  it("'Sending it replaces the open proposal' only when a proposal is open", async () => {
    const { scriptedReply } = await import("./model");
    expect(scriptedReply("make it $3,000 instead", 7500, undefined, { openProposal: true }).text).toMatch(/replaces the open proposal/);
    expect(scriptedReply("make it $3,000 instead", 7500).text).not.toMatch(/replaces/);
  });
  it("the prompt tells the model how to route loan questions", async () => {
    const { SYSTEM_PROMPT } = await import("./prompt");
    expect(SYSTEM_PROMPT).toMatch(/open loan.*showStatus/s);
    expect(SYSTEM_PROMPT).toMatch(/Who can move my funds/);
  });
});
