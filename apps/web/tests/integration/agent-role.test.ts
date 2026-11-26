import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { activity, proposals, safeNetworks } from "@/server/db/schema";
import { MOCK_COSIGNER, MOCK_OWNER_KEY, MOCK_SAFE, MOCK_STRANGER, MOCK_OWNER } from "@/server/mock/seed";
import { agentStatus, assertAgentActive } from "@/server/agent-role";
import { nextNonce } from "@/server/proposals/send";
import { safeContext } from "@/server/request";
import { HttpError } from "@/server/http";
import { currentTotp, delegateTypedData, safeTxHash } from "@/server/safe/hash";
import { getAddress, zeroAddress } from "viem";
import type { Address, ChainId, Hex, SafeTx } from "@/shared/types";
import { createTestWorld, type TestWorld } from "../helpers/world";
import { GET, POST, DELETE } from "@/app/api/safes/[address]/agent/route";
import { POST as TYPED } from "@/app/api/safes/[address]/agent/typed-data/route";

/** MOCK_SAFE in the seed has a bad checksum, which viem refuses to hash. */
const SAFE = getAddress(MOCK_SAFE.toLowerCase());
const owner = privateKeyToAccount(MOCK_OWNER_KEY);
const params = { params: Promise.resolve({ address: MOCK_SAFE }) };
const URL_ = `/api/safes/${MOCK_SAFE}/agent`;

let w: TestWorld;
let cookie: string;
let safeId: number;

async function sign(chainId: ChainId): Promise<Hex> {
  const agent = w.services.signer.address;
  return owner.signTypedData(delegateTypedData(chainId, agent));
}

async function add(chainId: ChainId = 8453) {
  return POST(w.req(URL_, { method: "POST", cookie, json: { chainId, signature: await sign(chainId) } }), params);
}

let n = 0;
async function propose(stage: "draft" | "queued", chainId: ChainId = 8453) {
  const tx: SafeTx = { to: MOCK_COSIGNER, value: String(++n), data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: String(n) };
  let hash: Hex | null = null;
  const id = `p${n}`;
  const row = { id, safeId, chainId, spec: {}, tx, idempotencyKey: id, title: `Proposal ${n}`, steps: [], outcome: "" };
  if (stage === "queued") {
    hash = safeTxHash(chainId, SAFE, tx);
    // The signer signs only stored proposals: store it as "sending", sign, then mark it queued.
    await w.db.insert(proposals).values({ ...row, nonce: BigInt(tx.nonce), safeTxHash: hash, stage: "sending" });
    const signed = await w.services.signer.signProposal({ proposalId: id, chainId, safe: SAFE });
    await w.services.fakes.get(chainId)!.proposeTransaction({ safe: SAFE, tx, safeTxHash: hash, sender: w.services.signer.address, signature: signed.signature });
    await w.db.update(proposals).set({ stage: "queued" }).where(eq(proposals.id, id));
  } else {
    await w.db.insert(proposals).values({ ...row, safeTxHash: null, stage });
  }
  return { id, hash, nonce: BigInt(tx.nonce) };
}

const stage = async (id: string) => (await w.db.select().from(proposals).where(eq(proposals.id, id)))[0];
const agentAdded = async (chainId: ChainId) =>
  (await w.db.select().from(safeNetworks).where(eq(safeNetworks.safeId, safeId))).find((r) => r.chainId === chainId)!.agentAdded;

beforeEach(async () => {
  w = await createTestWorld();
  cookie = (await w.signIn(MOCK_OWNER)).cookie;
  w.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  w.services.fakes.get(42161)!.setOwners(MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  safeId = await w.trackSafe(MOCK_SAFE, { chainIds: [8453, 42161] });
});
afterEach(() => w.reset());

describe("add the agent", () => {
  it("offers typed data for the agent as delegate and adds it for this Safe only, after read-back", async () => {
    const td = await (await TYPED(w.req(`${URL_}/typed-data`, { method: "POST", cookie, json: { chainId: 8453 } }), params)).json();
    expect(td.message.delegateAddress).toBe(w.services.signer.address);
    expect(td.primaryType).toBe("Delegate");

    expect((await (await GET(w.req(URL_, { cookie }), params)).json()).active).toBe(false);
    const res = await add(8453);
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status.networks.find((x: any) => x.chainId === 8453).added).toBe(true);
    expect(status.networks.find((x: any) => x.chainId === 42161).added).toBe(false);

    const fake = w.services.fakes.get(8453)!;
    const list = await fake.listDelegates(MOCK_SAFE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ delegate: w.services.signer.address, delegator: owner.address, label: "Lender agent" });
    expect(await fake.listDelegates("0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002")).toHaveLength(0);
    expect(await agentAdded(8453)).toBe(true);
    expect((await w.db.select().from(activity)).length).toBeGreaterThan(0);
  });

  it("a bad signature changes nothing and a retry works", async () => {
    const bad = await privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a")
      .signTypedData(delegateTypedData(8453, w.services.signer.address));
    const res = await POST(w.req(URL_, { method: "POST", cookie, json: { chainId: 8453, signature: bad } }), params);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await w.services.fakes.get(8453)!.listDelegates(MOCK_SAFE)).toHaveLength(0);
    expect(await agentAdded(8453)).toBe(false);
    expect((await POST(w.req(URL_, { method: "POST", cookie, json: { chainId: 8453 } }), params)).status).toBe(400);
    expect((await add(8453)).status).toBe(200);
    expect(await agentAdded(8453)).toBe(true);
  });

  it("does not set agent_added when the read-back does not show the delegate", async () => {
    const fake = w.services.fakes.get(8453)!;
    vi.spyOn(fake, "addDelegate").mockResolvedValue(undefined);
    const res = await add(8453);
    expect(res.status).toBe(502);
    expect(await agentAdded(8453)).toBe(false);
  });

  it("asks no signature for a network where the Safe is not deployed", async () => {
    await w.db.update(safeNetworks).set({ deployed: false }).where(eq(safeNetworks.chainId, 42161));
    const res = await TYPED(w.req(`${URL_}/typed-data`, { method: "POST", cookie, json: { chainId: 42161 } }), params);
    expect(res.status).toBe(409);
    expect((await add(42161)).status).toBe(409);
    const status = await (await GET(w.req(URL_, { cookie }), params)).json();
    expect(status.networks.find((x: any) => x.chainId === 42161)).toMatchObject({ deployed: false, added: false });
  });

  it("a stranger gets 403", async () => {
    const s = await w.signIn(MOCK_STRANGER);
    expect((await GET(w.req(URL_, { cookie: s.cookie }), params)).status).toBe(403);
    expect((await TYPED(w.req(`${URL_}/typed-data`, { method: "POST", cookie: s.cookie, json: { chainId: 8453 } }), params)).status).toBe(403);
    expect((await POST(w.req(URL_, { method: "POST", cookie: s.cookie, json: { chainId: 8453, signature: await sign(8453) } }), params)).status).toBe(403);
    expect((await DELETE(w.req(URL_, { method: "DELETE", cookie: s.cookie, json: { signatures: [] } }), params)).status).toBe(403);
  });
});

describe("remove the agent", () => {
  async function removeAll() {
    const signatures = [8453, 42161].map(async (c) => ({ chainId: c, signature: await sign(c as ChainId) }));
    return DELETE(w.req(URL_, { method: "DELETE", cookie, json: { signatures: await Promise.all(signatures) } }), params);
  }

  it("removes the delegate on every network and refuses to propose afterwards", async () => {
    await add(8453);
    await add(42161);
    await assertAgentActive(w.services, 8453, MOCK_SAFE);
    const res = await removeAll();
    expect(res.status).toBe(200);
    for (const c of [8453, 42161] as ChainId[]) {
      expect(await w.services.fakes.get(c)!.listDelegates(MOCK_SAFE)).toHaveLength(0);
      expect(await agentAdded(c)).toBe(false);
    }
    await expect(assertAgentActive(w.services, 8453, MOCK_SAFE)).rejects.toMatchObject({ status: 409, message: "The Lender agent is not on this Safe." });
  });

  it("stops open proposals, deletes the unconfirmed one, keeps the confirmed one", async () => {
    await add(8453);
    const draft = await propose("draft");
    const open = await propose("queued");
    const confirmed = await propose("queued");
    const fake = w.services.fakes.get(8453)!;
    fake.confirm(confirmed.hash!, MOCK_COSIGNER);
    const read = vi.spyOn(fake, "getMultisigTransaction");
    const del = vi.spyOn(fake, "deleteTransaction");

    expect((await removeAll()).status).toBe(200);

    expect(read).toHaveBeenCalledWith(confirmed.hash);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(open.hash, expect.any(String));
    expect(await fake.getMultisigTransaction(open.hash!)).toBeNull();
    expect(await fake.getMultisigTransaction(confirmed.hash!)).not.toBeNull();
    for (const p of [draft, open, confirmed]) {
      const row = await stage(p.id);
      expect(row.stage).toBe("stopped");
      expect(row.stopReason).toBe("agent_removed");
    }
    expect((await stage(open.id)).deletedFromQueue).toBe(true);
    expect((await stage(confirmed.id)).deletedFromQueue).toBe(false);
    expect(await stage(draft.id)).toMatchObject({ safeTxHash: null, deletedFromQueue: true });

    w.services.fixture.setNonce(8453, SAFE, open.nonce);
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(open.nonce);
    w.services.fixture.setNonce(8453, SAFE, confirmed.nonce);
    expect(await nextNonce(w.db, w.services, safeId, 8453, SAFE)).toBe(confirmed.nonce + 1n);

    const rows = await w.db.select().from(activity);
    expect(rows.filter((r) => r.proposalId).map((r) => r.eventKey).sort()).toEqual([
      `agent-removed-deleted:${open.id}`,
      `agent-removed:${draft.id}`,
      `agent-removed:${open.id}`,
      `agent-removed:${confirmed.id}`,
    ].sort());
  });

  it("a cancelled removal (bad signature) changes nothing", async () => {
    await add(8453);
    const p = await propose("queued");
    const res = await DELETE(w.req(URL_, { method: "DELETE", cookie, json: { signatures: [{ chainId: 8453, signature: `0x${"11".repeat(65)}` }] } }), params);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await agentAdded(8453)).toBe(true);
    expect((await stage(p.id)).stage).toBe("queued");
  });

  it("picks up a removal made directly in the Safe service", async () => {
    await add(8453);
    await w.services.fakes.get(8453)!.removeDelegate({ safe: MOCK_SAFE, delegate: w.services.signer.address, delegator: owner.address, signature: await sign(8453) });
    const ctx = await safeContext(w.req(URL_, { cookie }), MOCK_SAFE);
    const status = await agentStatus(ctx);
    expect(status.active).toBe(false);
    expect(await agentAdded(8453)).toBe(false);
    await expect(assertAgentActive(w.services, 8453, MOCK_SAFE)).rejects.toBeInstanceOf(HttpError);
  });
});

void currentTotp;
void (null as unknown as Address);
