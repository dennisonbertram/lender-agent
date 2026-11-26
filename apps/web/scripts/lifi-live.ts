// A live check of the LI.FI client (D-18): one quote and the recipient invariant on it. Not part of CI. Skips cleanly (exit 0)
// when there is no network. `LIFI_API_KEY` is optional (the public endpoint answers without one, rate-limited).
//   pnpm --filter @ai-loan-agent/web exec tsx scripts/lifi-live.ts
import { getAddress } from "viem";
import { createLifi } from "../src/server/moves/lifi";
import { checkMoveQuote } from "../src/server/moves/invariants";
import { NATIVE } from "../src/server/moves/types";

const safe = getAddress("0x9fC3dc011b461664c835F2527fffb1169b3C213e"); // the M0-7 Safe
async function main() {
  try {
    await fetch("https://li.quest/v1/chains", { signal: AbortSignal.timeout(8000) });
  } catch {
    console.log("SKIP: li.quest is not reachable from here.");
    return;
  }
  const q = await createLifi({ apiKey: process.env.LIFI_API_KEY }).quote({ fromChain: 8453, toChain: 1, fromToken: NATIVE, toToken: NATIVE, fromAmount: 10n ** 15n, address: safe });
  if (!q) { console.log("no route for ETH Base to Ethereum right now"); return; }
  const check = checkMoveQuote(q, { safe, fromChain: 8453, toChain: 1 });
  console.log({ tool: q.tool, toAmountMin: q.toAmountMin.toString(), durationSec: q.durationSec, feeUsd: q.feeUsd, invariant: check });
  if (!check.ok) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
