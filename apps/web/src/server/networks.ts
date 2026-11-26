// Add a network to a Safe (BP-35). The Safe has the same address on every network, so adding one is a row:
// set up there already (read from chain) or ready to be set up on first use. The agent is added afterwards, with the
// same signature flow as everywhere else (agent-role.ts); a network where the Safe is not set up is never asked for one.
import { safeNetworks } from "@/server/db/schema";
import { agentStatus, type AgentStatus } from "@/server/agent-role";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import { isChainId, type Address } from "@/shared/types";

export async function addSafeNetwork(ctx: SafeContext, chainId: unknown): Promise<AgentStatus> {
  if (typeof chainId !== "number" || !isChainId(chainId) || !SERVED_CHAIN_IDS.includes(chainId)) throw new HttpError(400, "This network is not available yet.");
  const { db, services, safe, networks, wallet } = ctx;
  if (!networks.some((n) => n.chainId === chainId)) {
    const owners = await services.reader.readSafeOwners(chainId, safe.address as Address);
    // Where the Safe already exists, the signer must own it there (same rule as every other read).
    if (owners && !owners.some((o) => o.toLowerCase() === wallet.toLowerCase())) throw new HttpError(403, "You are not an owner of this Safe on this network");
    await db.insert(safeNetworks).values({ safeId: safe.id, chainId, deployed: owners !== null, agentAdded: false })
      .onConflictDoNothing({ target: [safeNetworks.safeId, safeNetworks.chainId] });
  }
  return agentStatus(ctx);
}

