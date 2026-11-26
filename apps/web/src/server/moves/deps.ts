// What the moves code reaches outside for, in one object, so tests and MOCK=1 swap it whole: the aggregator, reads on the
// destination network, the simulation, Safe setup on the destination, and the loan draft on arrival.
import type { Db } from "@/server/db/client";
import type { OpenSpec } from "@/lib/proposals";
import type { Network } from "@/lib/types";
import type { ChatMessage } from "@/server/agent/persist";
import { HttpError } from "@/server/http";
import { setupDepsFor } from "@/server/safe-create/deps";
import { setupNetwork } from "@/server/safe-create/setup";
import type { Call } from "@/server/safe/multisend";
import type { Services } from "@/server/services";
import { isChainId, NETWORK_OF, type Address, type ChainId } from "@/shared/types";
import type { DestinationChain } from "./arrival";
import { createViemDestination } from "./chain";
import { chainName } from "./networks";
import { createLifi } from "./lifi";
import { defaultWorld, servedChains } from "./world";
import { fakeAggregator, fakeDestination } from "./testing";
import type { BridgeAggregator, MoveChain } from "./types";
import type { CrossPlanInput } from "./plan";

export type SetupOutcome = { ok: true } | { ok: false; reason: string };

export type MoveDeps = {
  aggregator: BridgeAggregator;
  destination: DestinationChain;
  simulate(p: { chainId: ChainId; safe: Address; calls: Required<Call>[] }): Promise<{ ok: boolean; failedStep?: number; feeUsd: number }>;
  /** The Safe must exist on the destination before funds go there (BP-37). */
  setupSafe(db: Db, chainId: MoveChain, safe: Address): Promise<SetupOutcome>;
  /** Message parts that hold the loan draft for the arrived funds (BP-38); empty when the destination is not a network we can draft a loan on. */
  draftLoan(c: { db: Db; services: Services; safeId: number; safeAddress: Address }, m: { then: OpenSpec; arrivedUnits: number; messageId: string }): Promise<ChatMessage["parts"]>;
  /** The Safe's holdings, prices and lenders as the library wants them, for planning a move (BP-36). Null: this build cannot plan across networks. */
  world?(c: { db: Db; services: Services; safeId: number; safeAddress: Address }, asked: { network: Network }): Promise<Omit<CrossPlanInput, "need" | "safeAddress"> | null>;
  now(): Date;
};

/** The default draft: a plan block for the loan, from live figures on the destination (the card fetches the quote and becomes the live draft). */
export const planBlockDraft: MoveDeps["draftLoan"] = async (_c, { then }) => {
  if (!servedChains().some((c) => NETWORK_OF[c] === then.network)) return []; // only the served networks (Base, Arbitrum) can be drafted on
  return [{ type: "data-block", data: { block: { kind: "plan", cash: then.borrow, asset: then.asset, network: then.network, venueId: then.venueId } } }];
};

/** Setup on the destination through the create-Safe code (BP-30): idempotent, sponsored or the owner pays. */
export async function setupViaSafeCreate(services: Services, db: Db, chainId: MoveChain, safe: Address, destination: DestinationChain): Promise<SetupOutcome> {
  if (await destination.hasCode(chainId, safe).catch(() => false)) return { ok: true };
  const net = chainName(chainId);
  try {
    const r = await setupNetwork(setupDepsFor(services, db), { address: safe, chainId });
    if (r.status === "ready") return { ok: true };
    if (r.status === "pending") return { ok: false, reason: `Your Safe is being set up on ${net}. Try again in a moment.` };
    if (r.status === "reverted") return { ok: false, reason: `The setup payment on ${net} reverted. No move was sent; set up the Safe again first.` };
    if (r.status === "not_deployed") return { ok: false, reason: `Your Safe is not deployed on ${net}; no setup payment was started. Set it up first.` };
    return { ok: false, reason: `Your Safe is not set up on ${net} yet. Set it up first (${r.cost}), then send the move.` };
  } catch (e) {
    return { ok: false, reason: e instanceof HttpError ? `Your Safe is not set up on ${net}, and I could not set it up: ${e.message}` : `Your Safe is not set up on ${net} and setup failed. Nothing was sent.` };
  }
}

const cache = new WeakMap<Services, MoveDeps>();
let override: MoveDeps | undefined;

export function getMoveDeps(services: Services, env: Record<string, string | undefined> = process.env): MoveDeps {
  if (override) return override;
  let d = cache.get(services);
  if (d) return d;
  if (services.mock) {
    // On the served networks the fixture chain is the truth: its deployment and owners, read live.
    const destination = fakeDestination({
      hasCode: async (chainId, safe) => isChainId(chainId) && services.reader.isDeployed(chainId, safe),
      ownersOf: async (chainId, safe) => (isChainId(chainId) ? services.reader.readSafeOwners(chainId, safe).catch(() => null) : null),
    });
    d = {
      aggregator: fakeAggregator(), destination,
      simulate: async () => ({ ok: true, feeUsd: 0.02 }),
      setupSafe: (db, chainId, safe) => setupViaSafeCreate(services, db, chainId, safe, destination),
      draftLoan: planBlockDraft, world: defaultWorld, now: () => new Date(),
    };
  } else {
    const destination = createViemDestination(env);
    d = {
      aggregator: createLifi({ apiKey: env.LIFI_API_KEY || undefined }), destination,
      simulate: async (p) => {
        const r = await services.testRunDeps.simulate(p);
        return { ok: r.ok, ...(r.failedStep !== undefined ? { failedStep: r.failedStep } : {}), feeUsd: r.feeUsd };
      },
      setupSafe: (db, chainId, safe) => setupViaSafeCreate(services, db, chainId, safe, destination),
      draftLoan: planBlockDraft, world: defaultWorld, now: () => new Date(),
    };
  }
  cache.set(services, d);
  return d;
}

/** Tests only. */
export const setMoveDepsForTests = (d: MoveDeps | undefined) => { override = d; };
