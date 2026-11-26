// `pnpm fork:price <usd> [safe]`: set the ETH/USD price Aave on Base uses, on the running anvil fork.
// Replaces the price source of WETH in the Aave oracle with a tiny fixed-price aggregator (hand-written runtime bytecode,
// the price is in storage slot 0, 8 decimals). Answers latestAnswer / latestRoundData / decimals. Morpho's oracles are not touched.
import { requireAnvil } from "./fork-guard.mjs";
import { createPublicClient, createTestClient, http, parseAbi, pad, toHex } from "viem";

const RPC = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8645";
const ORACLE = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156"; // AAVE[8453].oracle
const POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const WETH = "0x4200000000000000000000000000000000000006";

const usd = Number(process.argv[2]);
const safe = process.argv[3] ?? process.env.SAFE;
if (!(usd > 0)) { console.error("usage: pnpm fork:price <usd> [safe address]"); process.exit(1); }

// Runtime bytecode: selector 0xfeaf968c -> latestRoundData (1, slot0, now, now, 1); 0x313ce567 -> decimals (8); anything else -> latestAnswer (slot0).
function assemble() {
  const code = [];
  const labels = {};
  const fix = [];
  const op = (...b) => code.push(...b);
  const jumpTo = (name) => { op(0x60, 0); fix.push([code.length - 1, name]); };
  const label = (name) => { labels[name] = code.length; op(0x5b); };
  op(0x60, 0x00, 0x35, 0x60, 0xe0, 0x1c); // sel = calldataload(0) >> 224
  for (const [sel, name] of [[[0xfe, 0xaf, 0x96, 0x8c], "round"], [[0x31, 0x3c, 0xe5, 0x67], "dec"]]) {
    op(0x80, 0x63, ...sel, 0x14); jumpTo(name); op(0x57); // DUP1 PUSH4 sel EQ PUSH1 L JUMPI
  }
  op(0x60, 0x00, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3); // mstore(0, sload(0)); return(0, 32)
  label("dec");
  op(0x60, 0x08, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3);
  label("round");
  op(0x60, 0x01, 0x60, 0x00, 0x52); // roundId 1
  op(0x60, 0x00, 0x54, 0x60, 0x20, 0x52); // answer
  op(0x42, 0x60, 0x40, 0x52, 0x42, 0x60, 0x60, 0x52); // startedAt, updatedAt = timestamp
  op(0x60, 0x01, 0x60, 0x80, 0x52); // answeredInRound
  op(0x60, 0xa0, 0x60, 0x00, 0xf3);
  for (const [at, name] of fix) code[at] = labels[name];
  return toHex(Uint8Array.from(code));
}

await requireAnvil(RPC, "fork-price");
const pub = createPublicClient({ transport: http(RPC) });
const test = createTestClient({ mode: "anvil", transport: http(RPC) });
const oracleAbi = parseAbi(["function getSourceOfAsset(address) view returns (address)", "function getAssetPrice(address) view returns (uint256)"]);
const poolAbi = parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
const price = () => pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getAssetPrice", args: [WETH] });
const health = async () => {
  if (!safe) return null;
  const [, debt, , , , hf] = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [safe] });
  return debt === 0n ? "no debt" : (Number(hf) / 1e18).toFixed(4);
};

const source = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getSourceOfAsset", args: [WETH] });
const oldPrice = Number(await price()) / 1e8;
const oldHf = await health();
await test.setCode({ address: source, bytecode: assemble() });
await test.setStorageAt({ address: source, index: 0, value: pad(toHex(BigInt(Math.round(usd * 1e8))), { size: 32 }) });
const newPrice = Number(await price()) / 1e8;
if (Math.abs(newPrice - usd) > 0.01) { console.error(`price did not change: Aave reads ${newPrice}`); process.exit(1); }
console.log(`ETH/USD (Aave oracle ${ORACLE}, WETH source ${source}): ${oldPrice} -> ${newPrice}`);
if (safe) console.log(`Safe ${safe} health factor: ${oldHf} -> ${await health()}`);
