// The agent's proposer role on a Safe (BP-05..07, architecture 2 and 8.1-8.2). The agent is only
// ever a Transaction Service delegate: one owner signature per network adds or removes it, and
// every claim is confirmed by reading the live delegate list back.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getAddress } from "viem";
import type { Db } from "@/server/db/client";
import { proposals, safeNetworks, safes } from "@/server/db/schema";
import { recordActivity } from "@/server/activity";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import type { Services } from "@/server/services";
import { currentTotp, delegateTypedData } from "@/server/safe/hash";
import { isChainId, type Address, type ChainId, type Hex } from "@/shared/types";

export const AGENT_LABEL = "Lender agent";
export const AGENT_OFF_MESSAGE = "The Lender agent is not on this Safe.";

export type AgentNetworkStatus = { chainId: ChainId; deployed: boolean; added: boolean };
/** `otherChainIds` are deployed networks from the Safe's setup that the app does not serve. */
export type AgentStatus = {
  agentAddress: Address;
  networks: AgentNetworkStatus[];
  active: boolean;
  otherChainIds: number[];
  /** Deployed served networks where this viewer is an owner. */
  eligibleChainIds: ChainId[];
  /** Uses the same all-tracked-networks ownership rule as the chat routes. */
  canChat: boolean;
};

const lc = (a: string) => a.toLowerCase();

async function isDelegate(services: Services, chainId: ChainId, safe: Address, agent: Address): Promise<boolean> {
  const list = await services.safeService(chainId).listDelegates(safe);
  return list.some((d) => lc(d.delegate) === lc(agent) && (!d.safe || lc(d.safe) === lc(safe)));
}

/** Per tracked network: deployed, and whether the live delegate list holds the agent. Syncs `agent_added`. */
export async function agentStatus(ctx: SafeContext): Promise<AgentStatus> {
  const { db, services, safe } = ctx;
  const agent = services.signer.address;
  const rows = await db.select().from(safeNetworks).where(eq(safeNetworks.safeId, safe.id));
  const networks: AgentNetworkStatus[] = [];
  for (const row of rows.filter((r) => SERVED_CHAIN_IDS.includes(r.chainId)).sort((a, b) => a.chainId - b.chainId)) {
    if (!isChainId(row.chainId)) continue;
    let added = false;
    if (row.deployed) {
      added = await isDelegate(services, row.chainId, safe.address as Address, agent);
      if (added !== row.agentAdded) {
        await db.update(safeNetworks).set({ agentAdded: added, agentChangedAt: new Date() })
          .where(and(eq(safeNetworks.safeId, safe.id), eq(safeNetworks.chainId, row.chainId)));
        if (!added) {
          await recordActivity(db, {
            safeId: safe.id, chainId: row.chainId, actor: "Agent", kind: "status",
            text: "The Lender agent was removed from this Safe outside the app.",
          });
        }
      }
    } else if (row.agentAdded) {
      await db.update(safeNetworks).set({ agentAdded: false, agentChangedAt: new Date() })
        .where(and(eq(safeNetworks.safeId, safe.id), eq(safeNetworks.chainId, row.chainId)));
    }
    networks.push({ chainId: row.chainId, deployed: row.deployed, added });
  }
  return {
    agentAddress: agent,
    networks,
    active: networks.some((n) => n.added),
    otherChainIds: rows.filter((r) => r.deployed && !SERVED_CHAIN_IDS.includes(r.chainId)).map((r) => r.chainId).sort((a, b) => a - b),
    eligibleChainIds: networks.filter((n) => n.deployed && ctx.access.ownedChainIds.includes(n.chainId)).map((n) => n.chainId),
    canChat: ctx.access.chat,
  };
}

function deployedNetwork(ctx: SafeContext, chainId: unknown): ChainId {
  if (typeof chainId !== "number" || !isChainId(chainId)) throw new HttpError(400, "Unknown network.");
  const row = ctx.networks.find((n) => n.chainId === chainId);
  if (!row) throw new HttpError(404, "This Safe is not tracked on that network.");
  if (!ctx.access.ownedChainIds.includes(chainId)) throw new HttpError(403);
  // architecture 8.1: a network where the Safe is not deployed is not asked for a signature
  if (!row.deployed) throw new HttpError(409, "This Safe is not set up on that network yet.");
  return chainId;
}

/** The EIP-712 message the owner signs, to add or to remove the agent on one network. */
export function agentTypedData(ctx: SafeContext, chainId: number) {
  const id = deployedNetwork(ctx, chainId);
  const td = delegateTypedData(id, ctx.services.signer.address);
  // JSON-safe for the wire: the client turns totp back into a bigint
  return { chainId: id, ...td, message: { delegateAddress: td.message.delegateAddress, totp: td.message.totp.toString() } };
}

function asSignature(sig: unknown): Hex {
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "That signature is not valid.");
  return sig as Hex;
}

function serviceFailure(err: unknown): never {
  if (err instanceof HttpError) throw err;
  throw new HttpError(502, "Safe did not accept that. Nothing changed. Try again.");
}

async function setAdded(db: Db, safeId: number, chainId: ChainId, agentAdded: boolean) {
  await db.update(safeNetworks).set({ agentAdded, agentChangedAt: new Date() })
    .where(and(eq(safeNetworks.safeId, safeId), eq(safeNetworks.chainId, chainId)));
}

/** Register the agent as a delegate for this Safe only. Success only after the read-back. */
export async function addAgent(ctx: SafeContext, input: { chainId: number; signature: string }): Promise<AgentStatus> {
  const chainId = deployedNetwork(ctx, input.chainId);
  const signature = asSignature(input.signature);
  const { db, services, safe, wallet } = ctx;
  const agent = services.signer.address;
  const service = services.safeService(chainId);
  try {
    await service.addDelegate({ safe: getAddress(safe.address), delegate: getAddress(agent), delegator: getAddress(wallet), label: AGENT_LABEL, signature });
  } catch (err) {
    return serviceFailure(err);
  }
  let seen: boolean;
  try { seen = await isDelegate(services, chainId, safe.address as Address, agent); } catch (err) { return serviceFailure(err); }
  if (!seen) throw new HttpError(502, "Safe did not show the Lender agent after adding it. Nothing changed. Try again.");
  await setAdded(db, safe.id, chainId, true);
  await recordActivity(db, {
    safeId: safe.id, chainId, actor: "You", actorAddress: wallet, kind: "signed",
    text: "You added the Lender agent to this Safe. It can suggest transactions; it cannot sign or move money.",
  });
  return agentStatus(ctx);
}

/** Remove the agent on every network, then stop what it had open. */
export async function removeAgent(
  ctx: SafeContext,
  input: { signatures: { chainId: number; signature: string }[] },
): Promise<AgentStatus> {
  const { db, services, safe, wallet } = ctx;
  const agent = services.signer.address;
  const before = await agentStatus(ctx);
  const signed = new Map<ChainId, Hex>();
  for (const s of input.signatures ?? []) signed.set(deployedNetwork(ctx, s.chainId), asSignature(s.signature));
  const missing = before.networks.filter((n) => n.added && !signed.has(n.chainId));
  if (missing.length) throw new HttpError(400, "Each network needs your signature to remove the agent.");

  for (const n of before.networks.filter((x) => x.added)) {
    const service = services.safeService(n.chainId);
    try {
      await service.removeDelegate({ safe: getAddress(safe.address), delegate: getAddress(agent), delegator: getAddress(wallet), signature: signed.get(n.chainId)! });
    } catch (err) {
      return serviceFailure(err);
    }
    let still: boolean;
    try { still = await isDelegate(services, n.chainId, safe.address as Address, agent); } catch (err) { return serviceFailure(err); }
    if (still) throw new HttpError(502, "Safe still shows the Lender agent. Try again.");
    await setAdded(db, safe.id, n.chainId, false);
    await recordActivity(db, {
      safeId: safe.id, chainId: n.chainId, actor: "You", actorAddress: wallet, kind: "signed",
      text: "You removed the Lender agent from this Safe.",
    });
  }
  await stopAgentProposals(db, services, safe.id);
  return agentStatus(ctx);
}

/**
 * Stop open proposals without racing the sender. Every stage decision is made after locking and
 * reloading the proposal row. A durable submission intent with no visible Safe hash remains sending;
 * absence from the service is not proof that an in-flight request will not appear later.
 */
export async function stopAgentProposals(db: Db, services: Services, safeId: number, onlyId?: string): Promise<void> {
  const STOPPABLE = ["draft", "sending", "queued"] as const;
  const open = await db.select({ id: proposals.id }).from(proposals).where(and(
    eq(proposals.safeId, safeId), inArray(proposals.stage, [...STOPPABLE]), ...(onlyId ? [eq(proposals.id, onlyId)] : []),
  ));
  const [safeRow] = open.length ? await db.select({ address: safes.address }).from(safes).where(eq(safes.id, safeId)).limit(1) : [];
  if (!safeRow) return;
  const safeAddress = getAddress(safeRow.address) as Address;

  for (const { id } of open) {
    const deletion = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.safeId, safeId))).for("update").limit(1);
      if (!p || !STOPPABLE.includes(p.stage as (typeof STOPPABLE)[number])) return null;
      const chainId = p.chainId as ChainId;
      const stoppedText = `Stopped "${p.title}" because the Lender agent was removed.`;

      if (p.stage === "draft") {
        await tx.update(proposals).set({ stage: "stopped", stopReason: "agent_removed", deletedFromQueue: true, updatedAt: new Date() })
          .where(and(eq(proposals.id, p.id), eq(proposals.stage, "draft")));
        await recordActivity(tx as unknown as Db, {
          safeId, chainId, actor: "Agent", kind: "status", text: `${stoppedText} Nothing was sent.`, proposalId: p.id, eventKey: `agent-removed:${p.id}`,
        });
        return null;
      }

      let live;
      let lookupSucceeded = false;
      try {
        live = await services.safeService(chainId).getMultisigTransaction(p.safeTxHash as Hex);
        lookupSucceeded = true;
      } catch {
        live = null;
      }

      if (live?.isExecuted) {
        if (p.stage === "sending") {
          await tx.update(proposals).set({ stage: "queued", submissionAttemptedAt: p.submissionAttemptedAt ?? new Date(), updatedAt: new Date() })
            .where(and(eq(proposals.id, p.id), eq(proposals.stage, "sending")));
          await recordActivity(tx as unknown as Db, {
            safeId, chainId, actor: "Agent", kind: "proposed", text: `Sent "${p.title}" to your Safe queue.`,
            proposalId: p.id, eventKey: `proposed:${p.id}`,
          });
        }
        return null;
      }

      if (p.stage === "sending" && p.submissionAttemptedAt && (!lookupSucceeded || !live)) {
        const note = "The Lender agent was removed while Safe submission was pending. The outcome is still being checked. Review your Safe queue; do not send this transaction again.";
        await tx.update(proposals).set({ stopReason: note, updatedAt: new Date() })
          .where(and(eq(proposals.id, p.id), eq(proposals.stage, "sending")));
        await recordActivity(tx as unknown as Db, {
          safeId, chainId, actor: "Agent", kind: "status", text: note, proposalId: p.id, eventKey: `agent-removed-pending:${p.id}`,
        });
        return null;
      }

      if (!live && p.stage === "sending" && !p.submissionAttemptedAt && lookupSucceeded) {
        // No intent means no worker can POST this row. The live service also confirmed the hash is absent.
        await tx.update(proposals).set({ stage: "stopped", stopReason: "agent_removed", deletedFromQueue: true, updatedAt: new Date() })
          .where(and(eq(proposals.id, p.id), eq(proposals.stage, "sending"), isNull(proposals.submissionAttemptedAt)));
        await recordActivity(tx as unknown as Db, {
          safeId, chainId, actor: "Agent", kind: "status", text: `${stoppedText} Safe did not have it.`,
          proposalId: p.id, eventKey: `agent-removed:${p.id}`,
        });
        return null;
      }

      if (!live) {
        // For queued/attempted rows, absence may be index lag. Keep the nonce and ask the owner to check.
        await tx.update(proposals).set({ stage: "stopped", stopReason: "agent_removed", deletedFromQueue: false, updatedAt: new Date() })
          .where(and(eq(proposals.id, p.id), inArray(proposals.stage, ["sending", "queued"])));
        await recordActivity(tx as unknown as Db, {
          safeId, chainId, actor: "Agent", kind: "status", text: `${stoppedText} Safe could not confirm removal; review the Safe queue and reject it there if it is present.`,
          proposalId: p.id, eventKey: `agent-removed:${p.id}`,
        });
        return null;
      }

      await tx.update(proposals).set({ stage: "stopped", stopReason: "agent_removed", deletedFromQueue: false, updatedAt: new Date() })
        .where(and(eq(proposals.id, p.id), inArray(proposals.stage, ["sending", "queued"])));
      await recordActivity(tx as unknown as Db, {
        safeId, chainId, actor: "Agent", kind: "status",
        text: live.confirmations.length === 0
          ? `${stoppedText} Safe still has it while removal is being confirmed.`
          : `${stoppedText} An owner already signed it, so it remains in the Safe queue. Reject it in Safe too.`,
        proposalId: p.id, eventKey: `agent-removed:${p.id}`,
      });
      return live.confirmations.length === 0 ? { proposalId: p.id, chainId, safe: live.safe, hash: p.safeTxHash as Hex } : null;
    });

    if (!deletion) continue;
    try {
      const signature = await services.signer.signDeleteRequest({
        proposalId: deletion.proposalId, chainId: deletion.chainId, safe: deletion.safe, totp: currentTotp(),
      });
      await services.safeService(deletion.chainId).deleteTransaction(deletion.hash, signature);
      // A successful DELETE response is not enough if the service still returns the hash.
      const afterDelete = await services.safeService(deletion.chainId).getMultisigTransaction(deletion.hash);
      if (afterDelete) continue;
      await db.transaction(async (tx) => {
        const [fresh] = await tx.select().from(proposals).where(eq(proposals.id, deletion.proposalId)).for("update").limit(1);
        if (!fresh || fresh.stage !== "stopped" || fresh.deletedFromQueue) return;
        await tx.update(proposals).set({ deletedFromQueue: true, updatedAt: new Date() })
          .where(and(eq(proposals.id, fresh.id), eq(proposals.stage, "stopped"), eq(proposals.deletedFromQueue, false)));
        await recordActivity(tx as unknown as Db, {
          safeId, chainId: deletion.chainId, actor: "Agent", kind: "status",
          text: `"${fresh.title}" was deleted from the Safe queue.`, proposalId: fresh.id, eventKey: `agent-removed-deleted:${fresh.id}`,
        });
      });
    } catch {
      // Keep deletedFromQueue false: a failed or unconfirmed DELETE still holds the nonce.
    }
  }
}

/** Throws 409 unless the live delegate list holds the agent. Call before every proposal (BP-07). */
export async function assertAgentActive(services: Services, chainId: ChainId, safe: Address): Promise<void> {
  if (!(await isDelegate(services, chainId, safe, services.signer.address))) throw new HttpError(409, AGENT_OFF_MESSAGE);
}
