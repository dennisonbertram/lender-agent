import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, ...inputArgs] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(mode)) {
  console.error("Usage: pnpm mock <dev|build|start> [Next.js options]");
  process.exit(2);
}

const args = [...inputArgs];
if (mode !== "build" && !args.some((arg) => arg === "-H" || arg === "--hostname" || arg.startsWith("--hostname="))) {
  args.push("--hostname", "127.0.0.1");
}

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
if (!existsSync(nextCli)) {
  console.error("Next.js is not installed. Run `pnpm install --frozen-lockfile` from the repository root first.");
  process.exit(1);
}

// Keep the quickstart offline and local even when a developer has service credentials in .env.local.
// Next.js gives process.env precedence over .env files, so these empty values disable external config.
const overrides = {
  NODE_ENV: mode === "dev" ? "development" : "production",
  MOCK: "1",
  NEXT_PUBLIC_MOCK_WALLET: "1",
  NEXT_PUBLIC_LOCAL_DEMO: "1",
  NEXT_PUBLIC_FORK_RPC_URL: "",
  FORK: "",
  FORK_SAFES: "",
  DATABASE_URL: "",
  DATABASE_URL_UNPOOLED: "",
  PGLITE_DIR: "",
  MOCK_LLM: "",
  ANTHROPIC_API_KEY: "",
  RESEND_API_KEY: "",
  EMAIL_FROM: "",
  PRIVACY_EMAIL: "",
  APP_URL: "http://localhost:3000",
  SAFE_API_KEY: "",
  LIFI_API_KEY: "",
  CRON_SECRET: "",
  PROPOSER_SIGNER: "dev",
  PROPOSER_PRIVATE_KEY: "",
  DEV_PROPOSER_KEY: "",
  RELAYER: "",
  DEV_RELAYER_KEY: "",
  EXECUTOR_SIGNER: "dev",
  DEV_EXECUTOR_KEY: "",
};
for (const chainId of [1, 10, 100, 137, 8453, 84532, 42161]) {
  overrides[`RPC_URL_${chainId}`] = "http://127.0.0.1:1";
  overrides[`SAFE_TX_SERVICE_URL_${chainId}`] = "http://127.0.0.1:1";
}

const child = spawn(process.execPath, [nextCli, mode, ...args], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, ...overrides },
  stdio: "inherit",
});

let forwardedSignal;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    forwardedSignal = signal;
    child.kill(signal);
  });
}
child.on("error", (error) => {
  console.error(`Could not start Next.js: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (forwardedSignal) process.exitCode = forwardedSignal === "SIGINT" ? 130 : 143;
  else if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
