// `pnpm dev:fork`: the whole app against a local anvil copy of Base mainnet (real Aave v3 and Morpho, fake ETH).
// Starts anvil, deploys Safe 1.4.1 test Safes owned by anvil's dev keys 1 and 2, then runs `next dev` with FORK=1.
// Only anvil's well-known dev keys appear here. Ctrl-C stops next and anvil.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireAnvil } from "./fork-guard.mjs";

const PORT = process.env.PORT ?? "3400";
const ANVIL_PORT = process.env.ANVIL_PORT ?? "8645";
const UPSTREAM = process.env.BASE_FORK_RPC_URL ?? "https://mainnet.base.org";
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"; // SafeL2 1.4.1
const FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const FALLBACK = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const ZERO = "0x0000000000000000000000000000000000000000";
// anvil's default keys: 0 pays gas, 1 is the owner (dev wallet), 2 the co-signer.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const [deployer, owner, cosigner] = KEYS.map((k) => privateKeyToAccount(k));

const children = [];
let tmp;
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  setTimeout(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } } if (tmp) rmSync(tmp, { recursive: true, force: true }); process.exit(code); }, 1500).unref();
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once("exit", r))))).then(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); process.exit(code); });
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stopAll(0));
process.on("exit", () => { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } } });

const local = path.join(homedir(), ".foundry", "bin", "anvil");
const anvil = spawn(existsSync(local) ? local : "anvil", ["--fork-url", UPSTREAM, "--chain-id", "8453", "--port", ANVIL_PORT, "--silent", "--no-storage-caching", "--retries", "15", "--timeout", "60000", "--fork-retry-backoff", "500"], { stdio: ["ignore", "inherit", "inherit"] });
children.push(anvil);
anvil.on("error", (e) => { console.error(`could not start anvil (install foundry: https://getfoundry.sh): ${e.message}`); stopAll(1); });
anvil.on("exit", (code) => { if (!stopping) { console.error(`anvil exited (${code})`); stopAll(1); } });

const chain = { id: 8453, name: "Base fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

for (let i = 0; ; i++) {
  try { await pub.getBlockNumber(); break; } catch { if (i > 240) { console.error("anvil did not come up"); stopAll(1); await new Promise(() => {}); } await new Promise((r) => setTimeout(r, 500)); }
}

await requireAnvil(RPC, "dev-fork"); // the endpoint we are about to sign deploys to is the anvil we started

const setupAbi = parseAbi(["function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]);
const factoryAbi = parseAbi(["function createProxyWithNonce(address _singleton,bytes initializer,uint256 saltNonce) returns (address proxy)"]);

async function deploySafe(owners, threshold, saltNonce) {
  const initializer = encodeFunctionData({ abi: setupAbi, functionName: "setup", args: [owners, BigInt(threshold), ZERO, "0x", FALLBACK, ZERO, 0n, ZERO] });
  const args = { address: FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SINGLETON, initializer, saltNonce] };
  const { result: address } = await pub.simulateContract({ ...args, account: deployer });
  const hash = await wallet.writeContract(args);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Safe deployment reverted");
  await test.setBalance({ address, value: parseEther("1") });
  return address;
}

for (const a of [owner, cosigner, deployer]) await test.setBalance({ address: a.address, value: parseEther("100") });
const safe2of2 = await deploySafe([owner.address, cosigner.address], 2, 1n);
const safe1of1 = await deploySafe([owner.address], 1, 2n);
const safes = [
  { address: safe2of2, owners: [owner.address, cosigner.address], threshold: 2 },
  { address: safe1of1, owners: [owner.address], threshold: 1 },
];

tmp = mkdtempSync(path.join(tmpdir(), "lender-fork-"));
console.log(`\nFork mode (anvil ${RPC}, forking ${UPSTREAM})\n  2-of-2 Safe: ${safe2of2}  (owners: dev keys 1 and 2, 1 ETH)\n  1-of-1 Safe: ${safe1of1}  (owner: dev key 1, 1 ETH)\n  App:         http://localhost:${PORT}/  (dev wallet = anvil key 1; localStorage la:mockWalletKey = 2 switches to the co-signer)\n  Ctrl-C stops anvil too.\n`);

const env = { ...process.env, FORK: "1", MOCK: "", NODE_ENV: "development", NEXT_PUBLIC_MOCK_WALLET: "1", NEXT_PUBLIC_FORK_RPC_URL: RPC, RPC_URL_8453: RPC, PGLITE_DIR: path.join(tmp, "db"), DATABASE_URL: "", FORK_SAFES: JSON.stringify(safes), CRON_SECRET: process.env.CRON_SECRET ?? "fork-cron-secret", MONITOR_INTERVAL_MS: process.env.MONITOR_INTERVAL_MS ?? "1000", PORT };
const next = spawn("pnpm", ["exec", "next", "dev", "-p", PORT], { stdio: "inherit", env, cwd: path.join(import.meta.dirname, "..") });
children.push(next);
next.on("exit", (code) => stopAll(code ?? 0));
