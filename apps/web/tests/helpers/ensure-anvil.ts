// Vitest global setup: make sure anvil and forge (foundry) are available for the fork tests and
// the Test run helper recompile check.
// The workflow installs the same pinned foundry version; for runs elsewhere, when no anvil is found on
// PATH or in ~/.foundry/bin, download the pinned release into ~/.foundry/bin.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FOUNDRY_VERSION = "v1.9.0";

function onPath(): boolean {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

export default function setup() {
  const bin = path.join(os.homedir(), ".foundry", "bin");
  if ((existsSync(path.join(bin, "anvil")) && existsSync(path.join(bin, "forge"))) || onPath()) return;
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_${platform}_${arch}.tar.gz`;
  mkdirSync(bin, { recursive: true });
  console.log(`anvil or forge not found: installing foundry ${FOUNDRY_VERSION} into ${bin}`);
  execFileSync("sh", ["-c", `curl -fsSL "${url}" | tar -xz -C "${bin}" anvil forge`], { stdio: "inherit" });
}
