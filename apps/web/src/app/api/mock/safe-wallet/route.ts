// `MOCK=1` only: the Safe{Wallet} stand-in for local dev and E2E. 404 in every other mode.
import { decodeFunctionData, getAddress, isAddress, isHex } from "viem";
import { and, eq } from "drizzle-orm";
import { proposals, safes } from "@/server/db/schema";
import type { SafeTx } from "@/shared/types";
import { HttpError, toResponse } from "@/server/http";
import { mockConfirm, mockExecute } from "@/server/mock/safe-wallet";
import { getServices } from "@/server/services";
import { execCalldataMatches, execTransactionAbi } from "@/server/safe/exec";
import { safeTxHash } from "@/server/safe/hash";
import { isPreValidatedFor, recoverSafeSignature } from "@/server/safe/signature";
import { isChainId, type Address, type ChainId, type Hex } from "@/shared/types";

/**
 * The dev wallet "sends" an execTransaction to a Safe. Like the contract, it checks the call before anything runs:
 * the target is the proposal's Safe, every SafeTx field equals the stored one, and the signatures reach the threshold
 * (hash-bound signatures recover to owners; v=1 counts only for the sender). Anything else is rejected.
 */
async function executeCalldata(services: ReturnType<typeof getServices>, chainId: ChainId, data: Hex, target: Address, sender: Address) {
  const db = await services.db();
  const rows = await db.select({ tx: proposals.tx, safe: safes.address }).from(proposals).innerJoin(safes, eq(proposals.safeId, safes.id))
    .where(and(eq(proposals.chainId, chainId), eq(proposals.stage, "queued")));
  const hit = rows.find((r) => r.tx && execCalldataMatches(data, r.tx as SafeTx));
  if (!hit) throw new HttpError(404, "No queued proposal matches that transaction");
  if (hit.safe.toLowerCase() !== target.toLowerCase()) throw new HttpError(400, "That transaction is addressed to a different Safe");
  const tx = hit.tx as SafeTx;
  const safe = getAddress(hit.safe) as Address;
  const hash = safeTxHash(chainId, safe, tx);
  const info = await services.fakes!.get(chainId)!.getSafe(safe);
  if (!info) throw new HttpError(404, "Unknown Safe");
  const { args } = decodeFunctionData({ abi: execTransactionAbi, data });
  const sigs = args[9] as Hex;
  if ((sigs.length - 2) % 130 !== 0) throw new HttpError(400, "Malformed signatures");
  const signers: Address[] = [];
  for (let i = 2; i < sigs.length; i += 130) {
    const sig = `0x${sigs.slice(i, i + 130)}` as Hex;
    const v = Number.parseInt(sig.slice(130, 132), 16);
    let who: Address | null = null;
    if (v === 1) {
      if (isPreValidatedFor(sig, sender)) who = sender;
      else throw new HttpError(400, "A pre-approved signature is only valid for the sender");
    } else if (v === 27 || v === 28 || v === 31 || v === 32) who = await recoverSafeSignature(hash, sig);
    if (!who) throw new HttpError(400, "Invalid signature");
    if (!info.owners.some((o) => o.toLowerCase() === who!.toLowerCase())) throw new HttpError(400, "Signature is not from an owner");
    const prev = signers.at(-1);
    if (prev && BigInt(who) <= BigInt(prev)) throw new HttpError(400, "Signatures must be sorted by owner and distinct");
    signers.push(who);
  }
  if (signers.length < info.threshold) throw new HttpError(400, `Needs ${info.threshold} signatures, got ${signers.length}`);
  return mockExecute(services, chainId, hash);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const services = getServices();
    if (!services.mock) throw new HttpError(404, "Not found");
    const body = (await req.json().catch(() => null)) as { action?: string; chainId?: number; safeTxHash?: string; owner?: string; revert?: boolean } | null;
    const chainId = body?.chainId ?? 8453;
    if (!body || !isChainId(chainId) || (body.action !== "execute-tx" && (!body.safeTxHash || !isHex(body.safeTxHash)))) throw new HttpError(400);
    if (body.action === "confirm") {
      if (!body.owner || !isAddress(body.owner, { strict: false })) throw new HttpError(400);
      mockConfirm(services, chainId, body.safeTxHash as Hex, body.owner as Address);
      return Response.json({ ok: true });
    }
    if (body.action === "execute-tx") {
      const data = (body as { data?: string }).data;
      if (!data || !isHex(data)) throw new HttpError(400);
      const { to, from } = body as { to?: string; from?: string };
      if (!to || !isAddress(to, { strict: false }) || !from || !isAddress(from, { strict: false })) throw new HttpError(400, "to and from are required");
      return Response.json(await executeCalldata(services, chainId, data as Hex, to as Address, from as Address));
    }
    if (body.action === "execute") return Response.json(await mockExecute(services, chainId, body.safeTxHash as Hex, { revert: body.revert }));
    throw new HttpError(400, "action must be confirm or execute");
  } catch (err) {
    return toResponse(err);
  }
}
