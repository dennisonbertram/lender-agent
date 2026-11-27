import { DISCOVERY_CHAIN_IDS, mergeOwnedSafeSlices } from "@/lib/owned-safes";
import { HttpError, toResponse } from "@/server/http";
import { requireSession } from "@/server/request";
import { assertExpectedWallet, findOwnedSafes, findOwnedSafesOnChainWithStatus } from "@/server/safes";
import { getServices, type Services } from "@/server/services";
import type { Address, ChainId } from "@/shared/types";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

const KNOWN_SAFE_LIMIT = 64;
const KNOWN_SAFE_HEADER_LIMIT = 3_000;

function knownSafeAddresses(req: Request): Address[] {
  const raw = req.headers.get("x-known-safes");
  if (!raw) return [];
  if (raw.length > KNOWN_SAFE_HEADER_LIMIT) throw new HttpError(400, "Too many known Safes.");
  const parts = raw.split(",").filter(Boolean);
  if (parts.length > KNOWN_SAFE_LIMIT || parts.some((address) => !isAddress(address, { strict: false }))) throw new HttpError(400, "Invalid known Safe list.");
  return [...new Map(parts.map((address) => [address.toLowerCase(), address as Address])).values()];
}

function ownedSafeStream(services: Services, chainId: ChainId, wallet: Address, known: Address[]): Response {
  const knownSet = new Set(known.map((address) => address.toLowerCase()));
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (event: Record<string, unknown>) => {
        if (!canceled) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      write({ type: "start" });
      void findOwnedSafesOnChainWithStatus(services, chainId, wallet, {
        onCandidate: (event) => {
          if (event.safe) write({ type: "candidate", safe: mergeOwnedSafeSlices([event.safe])[0], complete: event.complete === true });
          else if (knownSet.has(event.address.toLowerCase())) write({ type: "candidate", address: event.address, status: event.status });
        },
      }).then((result) => {
        const candidates = new Set(result.candidateAddresses.map((address) => address.toLowerCase()));
        for (const address of known) if (!candidates.has(address.toLowerCase())) write({ type: "candidate", address, status: "removed" });
        write({ type: "done", partial: result.partial });
      }).catch(() => write({ type: "error" })).finally(() => {
        if (!canceled) controller.close();
      });
    },
    cancel() { canceled = true; },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

/**
 * Safes the wallet owns (Transaction Service, confirmed on-chain).
 * `?chainId=` scopes the lookup to one served network so the picker can show each network's results as they arrive;
 * without it the response is the original all-networks aggregate.
 */
export async function GET(req: Request) {
  try {
    const services = getServices();
    const { session } = await requireSession(req, services);
    assertExpectedWallet(req, session.address);
    const param = new URL(req.url).searchParams.get("chainId");
    if (param === null) return Response.json({ safes: await findOwnedSafes(services, session.address) });
    const chainId = Number(param) as ChainId;
    if (!DISCOVERY_CHAIN_IDS.includes(chainId)) throw new HttpError(400, "Enter a served network.");
    const known = knownSafeAddresses(req);
    if (req.headers.get("accept")?.toLowerCase().includes("application/x-ndjson")) return ownedSafeStream(services, chainId, session.address, known);
    const result = await findOwnedSafesOnChainWithStatus(services, chainId, session.address);
    return Response.json({
      safes: mergeOwnedSafeSlices(result.safes),
      ...(result.partial ? { partial: true } : {}),
      ...(known.length ? {
        indeterminateAddresses: result.indeterminateAddresses.filter((address) => knownSetContains(known, address)),
        notOwnedAddresses: result.notOwnedAddresses.filter((address) => knownSetContains(known, address)),
        removedAddresses: known.filter((address) => !result.candidateAddresses.some((candidate) => candidate.toLowerCase() === address.toLowerCase())),
      } : {}),
    });
  } catch (err) {
    return toResponse(err);
  }
}

const knownSetContains = (known: Address[], candidate: Address) => known.some((address) => address.toLowerCase() === candidate.toLowerCase());
