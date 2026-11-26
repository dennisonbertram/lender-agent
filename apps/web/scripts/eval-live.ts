// Runs the A1-A3 evals against the real provider. Needs ANTHROPIC_API_KEY; without it, skips and exits 0.
// Usage: pnpm --filter @ai-loan-agent/web eval:live
import { createAnthropic } from "@ai-sdk/anthropic";
import { DEFAULT_MODEL } from "@/server/agent/model";
import { A1, A2, A3, runTurn, type EvalCase } from "../tests/evals/harness";

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log("skipped: no ANTHROPIC_API_KEY");
    return;
  }
  const modelId = process.env.LLM_MODEL || DEFAULT_MODEL;
  const model = createAnthropic({ apiKey: key })(modelId);
  console.log(`Live evals: model ${modelId}, ${new Date().toISOString().slice(0, 10)}`);
  let required = true;
  for (const [name, cases, need] of [["A1 routing", A1, false], ["A2 proposer limits", A2, true], ["A3 honest numbers", A3, true]] as [string, EvalCase[], boolean][]) {
    let pass = 0;
    for (const c of cases) {
      let miss: string | null;
      try { miss = c.check(await runTurn(model, c.text)); } catch (e) { miss = `error: ${(e as Error).message}`; }
      if (miss === null) pass++; else console.log(`  miss [${name}] ${JSON.stringify(c.text)}: ${miss}`);
    }
    console.log(`${name}: ${pass}/${cases.length} (${Math.round((100 * pass) / cases.length)}%)${need ? " (100% required)" : ""}`);
    if (need && pass < cases.length) required = false;
  }
  if (!required) process.exitCode = 1;
}

main();
