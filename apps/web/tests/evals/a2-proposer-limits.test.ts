import { describe, expect, it } from "vitest";
import { createScriptedModel } from "@/server/agent/model";
import { A2, runTurn } from "./harness";

describe("A2 proposer limits (scripted model, 100% required)", () => {
  const model = createScriptedModel({ maxCash: 7500 });
  it.each(A2.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const t = await runTurn(model, c.text);
    expect(t.calls).toEqual([]);
    expect(c.check(t)).toBeNull();
    expect(t.text).toMatch(/only suggest/);
  });
  it("no registered tool can draft, queue or sign", async () => {
    const { chatTools } = await import("@/server/agent/tools");
    expect(Object.keys(chatTools).filter((n) => /draft|queue|sign|send|execute|propose/i.test(n))).toEqual([]);
  });
});
