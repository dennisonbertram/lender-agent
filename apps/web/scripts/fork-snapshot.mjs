// Refresh the fork snapshots: run every fork test against the live RPCs and record what anvil reads.
// Needs RPC access (FORK_RPC_URL_<chainId> for keyed endpoints). Commit tests/fixtures/fork-snapshots afterwards.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "tests", "fixtures", "fork-snapshots");
for (const f of readdirSync(dir)) if (f.endsWith(".json.gz") && !f.startsWith("8453-")) rmSync(path.join(dir, f)); // stale blocks
// Fresh pins for every chain but Base (its block stays fixed); the run's first fork of a chain records its block, the rest reuse it.
writeFileSync(path.join(dir, "blocks.json"), JSON.stringify({ 8453: JSON.parse(readFileSync(path.join(dir, "blocks.json"), "utf8"))["8453"] }, null, 2) + "\n");
const files = readdirSync(path.join(dir, "..", "..", "integration")).filter((f) => /fork|lenders-contract|chain-reads|safe-create\.test/.test(f)).map((f) => `tests/integration/${f}`);
const r = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "./vitest.config.ts", "--no-file-parallelism", ...files], {
  stdio: "inherit", env: { ...process.env, FORK_MODE: "live", FORK_UPDATE_BLOCKS: "1" },
});
const blocks = JSON.parse(readFileSync(path.join(dir, "blocks.json"), "utf8"));
for (const f of readdirSync(dir)) {
  const m = /^(\d+)-(\d+)\.json\.gz$/.exec(f);
  if (m && blocks[m[1]] !== m[2]) rmSync(path.join(dir, f)); // not referenced any more
}
process.exit(r.status ?? 1);
