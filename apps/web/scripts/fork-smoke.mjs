// Smoke test for `pnpm dev:fork`: plan, propose, co-sign, execute a $50 Aave loan for the 2-of-2 Safe.
// Uses the app's own routes (no model) and anvil's dev keys 1 (owner) and 2 (co-signer). Usage: node scripts/fork-smoke.mjs
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseAbi, toHex } from "viem";
import { requireAnvil } from "./fork-guard.mjs";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";

const APP = process.env.APP_URL ?? "http://localhost:3400";
const RPC = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8645";
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const cosigner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
await requireAnvil(RPC, "fork-smoke");
const pub = createPublicClient({ transport: http(RPC) });
const test = createTestClient({ mode: "anvil", transport: http(RPC) });
const step = (m) => console.log(`\n== ${m}`);
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

// The 2-of-2 is the one in the dev:fork banner, or pass SAFE=0x...
const safe = process.env.SAFE ?? process.argv[2];
if (!safe) fail("pass the 2-of-2 Safe address from the dev:fork banner: node scripts/fork-smoke.mjs 0x...");

async function session(account) {
  let cookie = "";
  const call = async (path, init = {}) => {
    const res = await fetch(`${APP}${path}`, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) } });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  const { nonce } = await call("/api/auth/nonce");
  const url = new URL(APP);
  const message = createSiweMessage({ domain: url.host, uri: url.origin, chainId: 8453, address: account.address, nonce, version: "1", statement: "Sign in to Lender agent. This only proves you own this wallet. No transaction is sent and no funds move." });
  await call("/api/auth/verify", { method: "POST", body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) });
  return call;
}

const base = `/api/safes/${safe}`;
step(`sign in as owner ${owner.address} and co-signer ${cosigner.address}`);
const ownerApi = await session(owner);
const coApi = await session(cosigner);
for (const api of [ownerApi, coApi]) await api("/api/safes", { method: "POST", body: JSON.stringify({ address: safe, name: "Fork 2-of-2" }) }).catch((e) => { if (!/already added/.test(e.message)) throw e; });
console.log("signed in and added the Safe (both)");

step("add the Lender agent as a delegate (owner signs the typed data)");
if ((await ownerApi(`${base}/agent`)).active) console.log("already added");
else {
  const td = await ownerApi(`${base}/agent/typed-data`, { method: "POST", body: JSON.stringify({ chainId: 8453 }) });
  const signature = await owner.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: { ...td.message, totp: BigInt(td.message.totp) } });
  console.log(`agent active: ${(await ownerApi(`${base}/agent`, { method: "POST", body: JSON.stringify({ chainId: 8453, signature }) })).active}`);
}

step("plan a $50 USDC loan on Aave");
const plan = { cash: 50, venueId: "aave-v3", venueChosen: true, messageId: `smoke-${Date.now()}` };
const quote = await ownerApi(`${base}/quote`, { method: "POST", body: JSON.stringify(plan) });
console.log(`quote status=${quote.status} venue=${quote.venueId} cash=${quote.cash} testRun=${JSON.stringify(quote.testRun)?.slice(0, 200)}`);

step("create the proposal (Send to Safe)");
const { messageId: _m, venueChosen: _v, ...sendPlan } = plan;
const sent = await ownerApi(`${base}/proposals`, { method: "POST", body: JSON.stringify({ ...sendPlan, chainId: 8453, draftKey: quote.draft?.draftKey }) });
console.log(JSON.stringify(sent));
const id = sent.proposalId;
if (!id || !["queued", "sending"].includes(sent.stage)) fail(`proposal not queued: ${JSON.stringify(sent)}`);

async function signAndExecute(id) {
  const pBase = `${base}/proposals/${id}`;
  for (const [name, acct, api] of [["owner", owner, ownerApi], ["co-signer", cosigner, coApi]]) {
    step(`${name} signs (sign-data, then confirm)`);
    const sd = await api(`${pBase}/sign-data`);
    if (!sd.canSign) fail(`${name} cannot sign: ${JSON.stringify(sd.reasons)}`);
    const signature = await acct.signTypedData({ domain: sd.typedData.domain, types: sd.typedData.types, primaryType: sd.typedData.primaryType, message: sd.typedData.message });
    const r = await api(`${pBase}/confirm`, { method: "POST", body: JSON.stringify({ signature }) });
    console.log(`confirmed by ${acct.address}, proposal stage=${r.proposal?.stage}`);
  }

  step("execute-data, then send execTransaction from the owner to anvil");
  const ex = await ownerApi(`${pBase}/execute-data`);
  if (!ex.ready) fail(`not ready: ${ex.needs} ${ex.reason}`);
  const hash = await createWalletClient({ account: owner, transport: http(RPC) }).sendTransaction({ chain: null, to: ex.to, data: ex.data, gas: BigInt(ex.gasLimit) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`tx ${hash} status=${receipt.status}`);
  if (receipt.status !== "success") fail("execTransaction reverted");
  const done = await ownerApi(`${pBase}/executed`, { method: "POST", body: JSON.stringify({ txHash: hash }) });
  console.log(`recorded, proposal stage=${done.proposal?.stage}`);

  step("assert the proposal reaches stage=executed");
  let finalStage = done.proposal?.stage;
  for (let i = 0; i < 10 && finalStage !== "executed"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    finalStage = ((await ownerApi(`${base}/proposals/list`)).proposals ?? []).find((p) => p.id === id)?.stage;
  }
  console.log(`proposal stage=${finalStage}`);
  if (finalStage !== "executed") fail(`proposal stage is ${finalStage}, expected executed`);
}
await signAndExecute(id);
step("assert on chain: Aave getUserAccountData(safe).totalDebtBase > 0");
const [, totalDebtBase, , , , hf] = await pub.readContract({
  address: AAVE_POOL, functionName: "getUserAccountData", args: [safe],
  abi: parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]),
});
console.log(`totalDebtBase=${totalDebtBase} (8-dec USD) healthFactor=${hf}`);
if (totalDebtBase <= 0n) fail("no Aave debt after execution");

step("assert the loans API lists the loan");
const loans = await ownerApi(`${base}/loans`);
console.log(JSON.stringify(loans.loans ?? loans).slice(0, 400));
if (!(loans.loans ?? []).length) fail("loans API returned no loans");


console.log("\nSMOKE OK (open)");

// ---- lifecycle: Watch, At-risk, repay and close ----
const CRON = process.env.CRON_SECRET ?? "fork-cron-secret";
const ORACLE = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const accountAbi = parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
const account = async () => { const [, debt, , , , hf] = await pub.readContract({ address: AAVE_POOL, functionName: "getUserAccountData", args: [safe], abi: accountAbi }); return { debt, hf: debt === 0n ? Infinity : Number(hf) / 1e18 }; };
const ethPrice = async () => Number(await pub.readContract({ address: ORACLE, abi: parseAbi(["function getAssetPrice(address) view returns (uint256)"]), functionName: "getAssetPrice", args: [WETH] })) / 1e8;
const setPrice = (usd) => console.log(execFileSync("node", [path.join(import.meta.dirname, "fork-price.mjs"), String(usd), safe], { encoding: "utf8", env: { ...process.env, FORK_RPC_URL: RPC } }).trim());
const setHealth = async (target) => { const { hf } = await account(); setPrice(((await ethPrice()) * target / hf).toFixed(2)); };
const worker = async () => {
  const res = await fetch(`${APP}/api/cron/worker`, { headers: { authorization: `Bearer ${CRON}` } });
  if (!res.ok) fail(`cron worker ${res.status} (is CRON_SECRET the one dev:fork uses?)`);
  const { results } = await res.json();
  const bad = results.filter((r) => r.job === "monitor" && r.status !== "ok");
  if (bad.length) fail(`monitor job: ${JSON.stringify(bad)}`);
};
const thread = async () => (await ownerApi(`${base}/chat`)).messages ?? [];
const loanOf = async () => ((await ownerApi(`${base}/loans`)).loans ?? []).find((l) => l.lender === "Aave v3");
const text = (m) => (m.parts ?? []).map((p) => p.text ?? p.data?.text ?? "").join(" ");
const originalPrice = await ethPrice();
const before = (await thread()).length;

async function expectStatus(status, health) {
  await setHealth(health);
  await new Promise((r) => setTimeout(r, 1200)); // MONITOR_INTERVAL_MS is 1 s in dev:fork
  let loan;
  for (let i = 0; i < 8; i++) { await worker(); loan = await loanOf(); if (loan?.status === status) break; await new Promise((r) => setTimeout(r, 1200)); }
  console.log(`loans API: status=${loan?.status} healthFactor=${loan?.healthFactor?.toFixed(3)}`);
  if (loan?.status !== status) fail(`expected loan status ${status}, got ${loan?.status}`);
}

step("ETH falls: health about 1.40, expect Watch and the Watch message in the chat");
await expectStatus("watch", 1.4);
let msgs = (await thread()).slice(before);
let watchMsg = msgs.find((m) => /^watch-/.test(m.id));
console.log(`chat: ${watchMsg ? `${watchMsg.id}: ${text(watchMsg)}` : "(none)"}`);
if (!watchMsg) fail("no Watch message in the chat thread");

step("ETH falls more: health about 1.20, expect At-risk and the alert in the chat");
await expectStatus("risk", 1.2);
msgs = (await thread()).slice(before);
const alertMsg = msgs.find((m) => /^alert-/.test(m.id));
console.log(`chat: ${alertMsg ? `${alertMsg.id}: ${text(alertMsg)}` : "(none)"}`);
if (!alertMsg) fail("no alert message in the chat thread");

step("ETH recovers to its original price; make sure the Safe holds the USDC to repay");
setPrice(originalPrice);
const owed = Number((await account()).debt) / 1e8; // base USD ~ USDC
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [safe, 9n])); // FiatToken balance slot
await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(BigInt(Math.ceil(owed * 1.1 + 100) * 1e6)), { size: 32 }) });
console.log(`Safe USDC set to about ${Math.ceil(owed * 1.1 + 100)} (owed about ${owed.toFixed(2)})`);

step("close the loan through the app (repay all, withdraw all)");
const loan = await loanOf();
const closed = await ownerApi(`${base}/loans/${encodeURIComponent(loan.id)}/close`, { method: "POST", body: "{}" });
console.log(JSON.stringify(closed));
if (!closed.proposalId || closed.stage !== "queued") fail(`close not queued: ${JSON.stringify(closed)}`);
await signAndExecute(closed.proposalId);

step("assert Aave debt is 0 and the loans API shows no open loan");
await worker();
const after = await account();
console.log(`Aave debt=${after.debt}`);
if (after.debt !== 0n) fail("Aave debt is not 0");
const rest = await loanOf();
console.log(`loans API: ${rest ? JSON.stringify(rest).slice(0, 200) : "no open Aave loan"}`);
if (rest) fail("loan still listed");
console.log("\nLIFECYCLE OK");
