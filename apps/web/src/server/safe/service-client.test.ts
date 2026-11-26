import { getAddress } from "viem";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS } from "../../../tests/helpers/anvil";
import { createTestDb, type Db } from "@/server/db/test-db";
import { proposals, safes } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { DevSigner } from "../signer/dev";
import { FakeSafeService } from "./fake-service";
import { currentTotp, delegateTypedData, safeTxHash, safeTxTypedData } from "./hash";
import { buildSafeTx } from "./multisend";
import { SafeServiceClient, SafeServiceError, serviceUrlFor } from "./service-client";
import type { Address, Hex, SafeTx } from "@/shared/types";

const owner1 = privateKeyToAccount(ANVIL_KEYS[0]);
const owner2 = privateKeyToAccount(ANVIL_KEYS[1]);
const owner3 = privateKeyToAccount(ANVIL_KEYS[2]);
let db: Db;
const agent = new DevSigner(ANVIL_KEYS[3], async () => db);
const stranger = new DevSigner(ANVIL_KEYS[4], async () => db);
let seq = 0;
/** The signer signs only stored proposals: store `tx` as a proposal (sending, or queued for deletes). */
async function store(tx: SafeTx, stage: "sending" | "queued" = "sending") {
  const [s] = await db.select().from(safes).where(eq(safes.address, SAFE)).limit(1);
  const safeId = s?.id ?? (await db.insert(safes).values({ address: SAFE, name: "t" }).returning())[0]!.id;
  const hash = safeTxHash(8453, SAFE, tx);
  const [dup] = await db.select().from(proposals).where(eq(proposals.safeTxHash, hash));
  if (dup) { await db.update(proposals).set({ stage }).where(eq(proposals.id, dup.id)); return dup.id; }
  const id = `sp${++seq}`;
  await db.insert(proposals).values({ id, safeId, chainId: 8453, spec: {}, tx, safeTxHash: safeTxHash(8453, SAFE, tx), idempotencyKey: id, title: id, steps: [], outcome: "", stage });
  return id;
}
const SAFE = "0xe4aAb4dfF32aBd99e3DD577C230553503a6AC7B3" as Address;
const TARGET = "0x4200000000000000000000000000000000000006" as Address;

const fake = new FakeSafeService(8453);
let server: Server;
let client: SafeServiceClient;
type Seen = { method: string; path: string; headers: Record<string, string>; body: any };
let seen: Seen[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = `http://127.0.0.1${req.url}`;
    seen.push({ method: req.method!, path: req.url!, headers: req.headers as Record<string, string>, body: raw ? JSON.parse(raw) : undefined });
    const r = await fake.handler(new Request(url, { method: req.method, headers: req.headers as any, body: raw || undefined }));
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    // No keep-alive: under load the gap between requests can pass the server's 5 s idle timeout, and fetch would reuse a socket the server just closed (ECONNRESET).
    res.setHeader("connection", "close");
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  client = new SafeServiceClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, apiKey: "k-123" });
});
afterAll(() => { server.close(); });
beforeEach(async () => {
  db = await createTestDb();
  fake.reset();
  seen = [];
  fake.setOwners(SAFE, [owner1.address, owner2.address, owner3.address], 2);
});

async function register() {
  const signature = await owner1.signTypedData(delegateTypedData(8453, agent.address));
  await client.addDelegate({ safe: SAFE, delegate: agent.address, delegator: owner1.address, label: "Lender agent", signature });
}
async function propose(nonce = 0, signer: DevSigner = agent) {
  const tx = buildSafeTx([{ to: TARGET, data: "0x095ea7b3" }, { to: TARGET, data: "0x" }], nonce);
  const id = await store(tx);
  const { safeTxHash: h, signature } = await signer.signProposal({ proposalId: id, chainId: 8453, safe: SAFE });
  await db.update(proposals).set({ stage: "queued" }).where(eq(proposals.id, id));
  await client.proposeTransaction({ safe: SAFE, tx, safeTxHash: h, sender: signer.address, signature, origin: { name: "lender-agent" } });
  return { tx, h, id };
}

describe("SafeServiceClient against the fake", () => {
  it("url config: env override then defaults", () => {
    expect(serviceUrlFor(8453, {})).toBe("https://safe-transaction-base.safe.global");
    expect(serviceUrlFor(84532, {})).toBe("https://safe-transaction-base-sepolia.safe.global");
    expect(serviceUrlFor(8453, { SAFE_TX_SERVICE_URL_8453: "http://x" })).toBe("http://x");
  });

  it("reads safes by owner and a Safe; unknown Safe is null", async () => {
    expect(await client.getSafesByOwner(owner2.address)).toEqual([SAFE]);
    expect(seen[0]).toMatchObject({ method: "GET", path: `/api/v1/owners/${owner2.address}/safes/` });
    const info = await client.getSafe(SAFE);
    expect(info).toMatchObject({ threshold: 2, nonce: 0 });
    expect(await client.getSafe("0x0000000000000000000000000000000000000001")).toBeNull();
  });

  it("adds, lists and removes a delegate with the M0-1 request shapes", async () => {
    await register();
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/v2/delegates/" });
    expect(seen[0]!.headers.authorization).toBe("Bearer k-123");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(Object.keys(seen[0]!.body).sort()).toEqual(["delegate", "delegator", "label", "safe", "signature"]);
    expect(await client.listDelegates(SAFE)).toEqual([
      { safe: SAFE, delegate: agent.address, delegator: owner1.address, label: "Lender agent", expiryDate: null },
    ]);
    expect(seen[1]).toMatchObject({ method: "GET", path: `/api/v2/delegates/?safe=${SAFE}` });
    const signature = await owner1.signTypedData(delegateTypedData(8453, agent.address));
    await client.removeDelegate({ safe: SAFE, delegate: agent.address, delegator: owner1.address, signature });
    expect(seen[2]).toMatchObject({ method: "DELETE", path: `/api/v2/delegates/${agent.address}/` });
    expect(seen[2]!.body).toEqual({ safe: SAFE, delegator: owner1.address, signature });
    expect(await client.listDelegates(SAFE)).toEqual([]);
  });

  it("refuses a delegate signed by a non-owner or with a stale totp", async () => {
    const sig = await privateKeyToAccount(ANVIL_KEYS[4]).signTypedData(delegateTypedData(8453, agent.address));
    await expect(client.addDelegate({ safe: SAFE, delegate: agent.address, delegator: owner1.address, signature: sig, label: "x" }))
      .rejects.toMatchObject({ status: 422 });
    const stale = await owner1.signTypedData(delegateTypedData(8453, agent.address, currentTotp() - 5));
    await expect(client.addDelegate({ safe: SAFE, delegate: agent.address, delegator: owner1.address, signature: stale, label: "x" }))
      .rejects.toBeInstanceOf(SafeServiceError);
  });

  it("proposes: 201 with an empty body; body matches the service shape; delegate proposal fields", async () => {
    await register();
    seen = [];
    const { tx, h } = await propose(0);
    expect(seen[0]).toMatchObject({ method: "POST", path: `/api/v2/safes/${SAFE}/multisig-transactions/` });
    expect(seen[0]!.body).toMatchObject({
      to: tx.to, value: "0", operation: 1, safeTxGas: "0", baseGas: "0", gasPrice: "0", nonce: "0",
      contractTransactionHash: h, sender: agent.address, origin: { name: "lender-agent" },
    });
    const got = await client.getMultisigTransaction(h);
    expect(got).toMatchObject({
      safeTxHash: h, operation: 1, proposer: owner1.address, proposedByDelegate: agent.address,
      isExecuted: false, isSuccessful: null, transactionHash: null, confirmations: [],
    });
  });

  it("confirms with an owner's real signature over HTTP; refuses a stranger, a duplicate and an executed tx", async () => {
    await register();
    const { tx, h } = await propose(0);
    const sign = (k: Hex) => privateKeyToAccount(k).signTypedData(safeTxTypedData(8453, SAFE, tx));
    seen = [];
    const sig = await sign(ANVIL_KEYS[1]);
    await client.confirmTransaction({ safeTxHash: h, signature: sig });
    expect(seen[0]).toMatchObject({ method: "POST", path: `/api/v1/multisig-transactions/${h}/confirmations/`, body: { signature: sig } });
    const got = await client.getMultisigTransaction(h);
    expect(got!.confirmations).toEqual([expect.objectContaining({ owner: owner2.address, signature: sig })]);
    await expect(client.confirmTransaction({ safeTxHash: h, signature: sig })).rejects.toMatchObject({ status: 422 });
    await expect(client.confirmTransaction({ safeTxHash: h, signature: await sign(ANVIL_KEYS[4]) })).rejects.toMatchObject({ status: 422 });
    await expect(client.confirmTransaction({ safeTxHash: `0x${"00".repeat(32)}`, signature: sig })).rejects.toMatchObject({ status: 404 });
    fake.markExecuted(h, { success: true, txHash: `0x${"22".repeat(32)}` });
    await expect(client.confirmTransaction({ safeTxHash: h, signature: await sign(ANVIL_KEYS[2]) })).rejects.toMatchObject({ status: 422 });
  });

  it("refuses proposals from a stranger, a bad signature, a wrong hash, or a duplicate", async () => {
    await expect(propose(0)).rejects.toMatchObject({ status: 422 }); // agent not registered yet
    await register();
    await expect(propose(0, stranger)).rejects.toMatchObject({ status: 422 });
    const tx = buildSafeTx([{ to: TARGET }], 0);
    const pid = await store(tx);
    const good = await agent.signProposal({ proposalId: pid, chainId: 8453, safe: SAFE });
    const other = await stranger.signProposal({ proposalId: pid, chainId: 8453, safe: SAFE });
    await expect(client.proposeTransaction({ safe: SAFE, tx, safeTxHash: good.safeTxHash, sender: agent.address, signature: other.signature }))
      .rejects.toMatchObject({ status: 422 });
    await expect(client.proposeTransaction({ safe: SAFE, tx, safeTxHash: `0x${"00".repeat(32)}`, sender: agent.address, signature: good.signature }))
      .rejects.toMatchObject({ status: 422 });
    await client.proposeTransaction({ safe: SAFE, tx, safeTxHash: good.safeTxHash, sender: agent.address, signature: good.signature });
    await expect(client.proposeTransaction({ safe: SAFE, tx, safeTxHash: good.safeTxHash, sender: agent.address, signature: good.signature }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("an owner proposal carries the owner's confirmation; eth_sign style delegate signature is accepted", async () => {
    const tx = buildSafeTx([{ to: TARGET }], 0);
    const h = safeTxHash(8453, SAFE, tx);
    const sig = await owner1.signMessage({ message: { raw: h } });
    const v = (parseInt(sig.slice(-2), 16) + 4).toString(16);
    await client.proposeTransaction({ safe: SAFE, tx, safeTxHash: h, sender: owner1.address, signature: (sig.slice(0, -2) + v) as Hex });
    const got = await client.getMultisigTransaction(h);
    expect(got!.confirmations.map((c) => c.owner)).toEqual([owner1.address]);
    expect(got!.proposedByDelegate).toBeNull();
  });

  it("404 gives null; confirm and markExecuted show in the read", async () => {
    expect(await client.getMultisigTransaction(`0x${"ab".repeat(32)}`)).toBeNull();
    await register();
    const { h } = await propose(0);
    fake.confirm(h, owner2.address);
    let got = await client.getMultisigTransaction(h);
    expect(got!.confirmations).toHaveLength(1);
    expect(got!.confirmations[0]).toMatchObject({ owner: owner2.address });
    expect(typeof got!.confirmations[0]!.submissionDate).toBe("string");
    fake.markExecuted(h, { success: false, txHash: `0x${"cd".repeat(32)}` });
    got = await client.getMultisigTransaction(h);
    expect(got).toMatchObject({ isExecuted: true, isSuccessful: false, transactionHash: `0x${"cd".repeat(32)}` });
    expect((await client.getSafe(SAFE))!.nonce).toBe(1);
  });

  it("delete: by the proposing delegate (even when confirmed, like the real service); not by others", async () => {
    await register();
    const a = await propose(0);
    const totp = currentTotp();
    const bySomeoneElse = await stranger.signDeleteRequest({ proposalId: a.id, chainId: 8453, safe: SAFE, totp });
    await expect(client.deleteTransaction(a.h, bySomeoneElse)).rejects.toMatchObject({ status: 422 });
    expect(await client.getMultisigTransaction(a.h)).not.toBeNull();

    fake.confirm(a.h, owner2.address); // the live service now has a confirmation; the stored record has none
    seen = [];
    const sig = await agent.signDeleteRequest({ proposalId: a.id, chainId: 8453, safe: SAFE, totp });
    await client.deleteTransaction(a.h, sig);
    expect(seen[0]).toMatchObject({ method: "DELETE", path: `/api/v1/multisig-transactions/${a.h}/`, body: { signature: sig } });
    expect(await client.getMultisigTransaction(a.h)).toBeNull();
    await expect(client.deleteTransaction(a.h, sig)).rejects.toMatchObject({ status: 404 });
  });

  it("unknown status surfaces as SafeServiceError with the code", async () => {
    const broken = new SafeServiceClient({ baseUrl: "http://x", fetch: async () => new Response("boom", { status: 503 }) });
    const err = await broken.getSafe(SAFE).catch((e) => e);
    expect(err).toBeInstanceOf(SafeServiceError);
    expect(err.status).toBe(503);
    await expect(broken.getMultisigTransaction(`0x${"ab".repeat(32)}`)).rejects.toMatchObject({ status: 503 });
  });

  it("sends checksummed addresses (the hosted service answers 422 to lowercase)", async () => {
    const urls: string[] = [];
    const c = new SafeServiceClient({ baseUrl: "http://x", fetch: async (u) => { urls.push(String(u)); return new Response(JSON.stringify({ safes: [], results: [] }), { status: 200 }); } });
    const owner = "0x1bac34e489d2b5a1929f92433653a4ad622759e6";
    await c.getSafesByOwner(owner);
    await c.listDelegates(owner);
    expect(urls).toEqual([`http://x/api/v1/owners/${getAddress(owner)}/safes/`, `http://x/api/v2/delegates/?safe=${getAddress(owner)}`]);
  });

  it("the fake can also be used in-process as a SafeService", async () => {
    expect(await fake.getSafe(SAFE)).toMatchObject({ threshold: 2 });
    expect(await fake.getMultisigTransaction(`0x${"ab".repeat(32)}`)).toBeNull();
  });
});
