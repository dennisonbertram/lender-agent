import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELPER_RUNTIME_BYTECODE, HELPER_SOURCE_SHA256 } from "./helper-bytecode";

const source = path.join(__dirname, "TestRunHelper.sol");

describe("TestRunHelper bytecode", () => {
  it("was built from the committed source", () => {
    expect(createHash("sha256").update(readFileSync(source)).digest("hex")).toBe(HELPER_SOURCE_SHA256);
  });
  it("matches a recompile with solc 0.8.24 ", () => {
    const forge = [path.join(os.homedir(), ".foundry", "bin", "forge"), "forge"].find((f) => {
      try { execFileSync(f, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
    });
    // tests/helpers/ensure-anvil.ts installs the pinned forge, so this check always runs.
    if (!forge) throw new Error("forge not found: the vitest global setup should have installed it");
    const dir = mkdtempSync(path.join(os.tmpdir(), "helper-"));
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "TestRunHelper.sol"), readFileSync(source));
    writeFileSync(path.join(dir, "foundry.toml"), '[profile.default]\nsolc_version = "0.8.24"\nevm_version = "cancun"\noptimizer = true\noptimizer_runs = 200\nbytecode_hash = "none"\ncbor_metadata = false\n');
    execFileSync(forge, ["build", "--root", dir], { stdio: "ignore" });
    const art = JSON.parse(readFileSync(path.join(dir, "out", "TestRunHelper.sol", "TestRunHelper.json"), "utf8"));
    expect(art.deployedBytecode.object).toBe(HELPER_RUNTIME_BYTECODE);
  }, 180_000);
});
