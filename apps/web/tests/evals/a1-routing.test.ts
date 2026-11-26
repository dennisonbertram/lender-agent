import { describe, expect, it } from "vitest";
import { createScriptedModel } from "@/server/agent/model";
import { A1, runTurn } from "./harness";

describe("A1 routing (scripted model)", () => {
  const model = createScriptedModel({ maxCash: 7500 });
  it.each(A1.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    expect(c.check(await runTurn(model, c.text))).toBeNull();
  });
  it("one tool, one block, a lead sentence with no figure", async () => {
    const t = await runTurn(model, "I need $12k");
    expect(t.calls).toHaveLength(1);
    expect(t.blocks).toEqual([{ kind: "plan", cash: 12000 }]);
    expect(t.text).toBe("Here is a plan. Change anything below.");
  });
  it("an unfunded Safe is sent to add funds", async () => {
    const t = await runTurn(createScriptedModel({ maxCash: 0 }), "I need $12k");
    expect(t.blocks).toEqual([{ kind: "addfunds" }]);
  });
});
