// Route logic for create and setup. Handlers stay thin; this is testable without Next.
import { and, eq } from "drizzle-orm";
import { isAddress, isHex, type Hex } from "viem";
import { ENABLED_CHAIN_IDS, isSafeNetwork, setupCostLine } from "@/lib/safe-create";
import { safeCreations, safes, userSafes } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { requireSession } from "@/server/request";
import type { Services } from "@/server/services";
import type { Address, SafeSetup } from "@/shared/types";
import { setupDepsFor } from "./deps";
import { budgetFromEnv, sponsorshipFor } from "./sponsorship";
import { reconcileSetupNetwork, setupNetwork } from "./setup";
import { createSafeRecord, previewSafe } from "./store";

const strings = (v: unknown): string[] => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : []);

function parseDraft(body: Record<string, unknown> | null) {
  if (!body || typeof body.name !== "string") throw new HttpError(400, "Enter a name.");
  return { name: body.name, cosigners: strings(body.cosigners), threshold: Number(body.threshold) };
}

/** The networks the owner chose, in order, each one enabled. The first is the one `chainId` names in the preview. */
const chosenChains = (networks: unknown): number[] => {
  const ids = Array.isArray(networks) ? networks.map(Number).filter((n) => ENABLED_CHAIN_IDS.includes(n)) : [8453];
  const unique = [...new Set(ids)];
  if (!unique.length) throw new HttpError(400, "Pick at least one network.");
  return unique;
};

/** Review step: the address and the text the wallet will sign, plus the honest setup-cost line. */
export async function previewHandler(req: Request, services: Services) {
  const { db, session } = await requireSession(req, services);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const preview = await previewSafe(db, { creator: session.address, ...parseDraft(body) });
  const chains = chosenChains(body?.networks);
  // A relayer that is not configured cannot sponsor. Each network has its own fee line.
  const relayerReady = setupDepsFor(services, db).relayer.address !== null;
  const networks = await Promise.all(chains.map(async (chainId) => {
    const decision = await sponsorshipFor(db, { safeId: null, creator: session.address, chainId, budget: budgetFromEnv(), now: new Date() });
    const sponsored = decision.sponsored && relayerReady;
    const shown = sponsored ? decision : { sponsored: false as const, reason: "relayer_unavailable" as const };
    return { chainId, sponsored, cost: setupCostLine(chainId, shown) };
  }));
  const first = networks[0]!;
  return { address: preview.address, index: preview.index, message: preview.message, owners: preview.setup.owners, threshold: preview.setup.threshold, sponsored: first.sponsored, cost: first.cost, chainId: first.chainId, networks };
}

export async function createHandler(req: Request, services: Services) {
  const { db, session } = await requireSession(req, services);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const draft = parseDraft(body);
  if (typeof body?.signature !== "string" || !isHex(body.signature)) throw new HttpError(400, "We could not check your signature. Try again.");
  const networks = (Array.isArray(body.networks) ? body.networks.map(Number) : [8453]).filter((n) => isSafeNetwork(n) && ENABLED_CHAIN_IDS.includes(n));
  const rec = await createSafeRecord(db, { userId: session.userId, creator: session.address, ...draft, index: Number(body.index), signature: body.signature as Hex, networks });
  return { address: rec.address, chainIds: rec.networks };
}

/** Only the creator or a stored owner may set a Safe up: it is not deployed yet, so the chain cannot say who owns it. */
async function setupContext(req: Request, address: string, services: Services) {
  if (!isAddress(address, { strict: false })) throw new HttpError(400, "This is not a valid address.");
  const { db, session } = await requireSession(req, services);
  const [row] = await db.select({ setup: safes.setup }).from(safes)
    .innerJoin(userSafes, eq(userSafes.safeId, safes.id))
    .innerJoin(safeCreations, eq(safeCreations.safeId, safes.id))
    .where(and(eq(safes.address, address.toLowerCase()), eq(userSafes.userId, session.userId))).limit(1);
  const setup = row?.setup as SafeSetup | undefined;
  if (!setup || !setup.owners.some((o) => o.toLowerCase() === session.address.toLowerCase())) throw new HttpError(404, "Safe not found");
  return { db, session };
}

function networkOf(chainId: unknown): number {
  const id = Number(chainId);
  if (!isSafeNetwork(id) || !ENABLED_CHAIN_IDS.includes(id)) throw new HttpError(400, "This network is not available yet.");
  return id;
}

/** Run setup on one network: sponsored by the relayer, or the one-time fee for the user. */
export async function setupHandler(req: Request, address: string, services: Services) {
  const { db } = await setupContext(req, address, services);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const chainId = networkOf(body?.chainId);
  if (body?.reconcile === true) return reconcileSetupNetwork(setupDepsFor(services, db), { address, chainId });
  const txHash = typeof body?.txHash === "string" && isHex(body.txHash) ? (body.txHash as Hex) : undefined;
  return setupNetwork(setupDepsFor(services, db), { address, chainId, userTxHash: txHash });
}

/** Is the Safe on the network, and does the Transaction Service list it yet? The app waits on this before the agent signature. */
export async function setupStatusHandler(req: Request, address: string, chainId: unknown, services: Services) {
  const { db } = await setupContext(req, address, services);
  const id = networkOf(chainId);
  const deps = setupDepsFor(services, db);
  const deployed = await deps.hasCode(id, address as Address);
  return { deployed, indexed: deployed && (await deps.isIndexed(id, address as Address)) };
}
