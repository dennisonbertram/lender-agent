import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { createTestDb, type Db } from "@/server/db/test-db";
import { ANVIL_KEYS } from "../../../tests/helpers/anvil";
import { NONCE_TTL_MS, SiweError, buildSignInMessage, issueNonce, verifySignIn as verifyWith } from "./siwe";

type Verify = NonNullable<Parameters<typeof verifyWith>[1]["publicClient"]>["verifyMessage"];
// No test touches the network: the chain is always a stub (default: "not valid").
let chainVerify = vi.fn<Verify>(async () => false);
const verifySignIn = (db: Db, p: Parameters<typeof verifyWith>[1]) =>
  verifyWith(db, { publicClient: { verifyMessage: chainVerify as unknown as PublicClient["verifyMessage"] }, ...p });

const owner = privateKeyToAccount(ANVIL_KEYS[1]);
const stranger = privateKeyToAccount(ANVIL_KEYS[2]);
const domain = "lender.example";
const uri = "https://lender.example";
let db: Db;

beforeEach(async () => { db = await createTestDb(); chainVerify = vi.fn<Verify>(async () => false); });

const signed = async (opts: { account?: typeof owner; signer?: typeof owner; domain?: string; nonce?: string; now?: Date } = {}) => {
  const account = opts.account ?? owner;
  const nonce = opts.nonce ?? (await issueNonce(db, opts.now));
  const message = buildSignInMessage({ domain: opts.domain ?? domain, uri, chainId: 8453, address: account.address, nonce, now: opts.now });
  const signature = await (opts.signer ?? account).signMessage({ message });
  return { message, signature, nonce };
};

describe("sign-in message", () => {
  it("states domain, uri, chain id, nonce, and that no transaction is sent", async () => {
    const { message, nonce } = await signed();
    const m = parseSiweMessage(message);
    expect(m.domain).toBe(domain);
    expect(m.uri).toBe(uri);
    expect(m.chainId).toBe(8453);
    expect(m.nonce).toBe(nonce);
    expect(m.address).toBe(owner.address);
    expect(message).toContain("wants you to sign in with your Ethereum account");
    expect(m.statement).toMatch(/No transaction is sent/);
  });
});

describe("verifySignIn", () => {
  it("accepts a good signature and returns the lowercase address", async () => {
    const s = await signed();
    await expect(verifySignIn(db, { ...s, domain })).resolves.toEqual({ address: owner.address.toLowerCase(), chainId: 8453 });
    expect(chainVerify).not.toHaveBeenCalled();
  });

  it("spends the nonce: a replay fails", async () => {
    const s = await signed();
    await verifySignIn(db, { ...s, domain });
    await expect(verifySignIn(db, { ...s, domain })).rejects.toBeInstanceOf(SiweError);
  });

  it("rejects an expired nonce", async () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const s = await signed({ now: issued });
    const later = new Date(issued.getTime() + NONCE_TTL_MS + 1000);
    await expect(verifySignIn(db, { ...s, domain, now: later })).rejects.toThrow(/expired or already used/);
  });

  it("rejects a nonce the server never issued", async () => {
    const s = await signed({ nonce: "neverissued123" });
    await expect(verifySignIn(db, { ...s, domain })).rejects.toBeInstanceOf(SiweError);
  });

  it("rejects the wrong domain", async () => {
    const s = await signed({ domain: "evil.example" });
    await expect(verifySignIn(db, { ...s, domain })).rejects.toThrow(/does not match this site/);
  });

  it("rejects a signature from a different wallet and keeps the nonce usable", async () => {
    const s = await signed({ signer: stranger });
    await expect(verifySignIn(db, { ...s, domain })).rejects.toThrow(/Signature/);
    expect(chainVerify).toHaveBeenCalledTimes(1); // EOA mismatch falls through to the chain, which says no
    const good = await signed({ nonce: s.nonce });
    await expect(verifySignIn(db, { ...good, domain })).resolves.toBeTruthy();
  });

  it("rejects garbage", async () => {
    await expect(verifySignIn(db, { message: "hello", signature: "0x00", domain })).rejects.toBeInstanceOf(SiweError);
  });
});

describe("verifySignIn with a smart-wallet (ERC-1271 / ERC-6492) signature", () => {
  const smartWallet = "0x1111111111111111111111111111111111111111" as const;
  const smartSigned = async () => {
    const nonce = await issueNonce(db);
    const message = buildSignInMessage({ domain, uri, chainId: 8453, address: smartWallet, nonce });
    return { message, signature: "0xdeadbeef" as const };
  };

  it("accepts when the chain says the contract wallet signature is valid", async () => {
    chainVerify.mockResolvedValue(true);
    const s = await smartSigned();
    await expect(verifySignIn(db, { ...s, domain })).resolves.toEqual({ address: smartWallet, chainId: 8453 });
    expect(chainVerify).toHaveBeenCalledWith({ address: smartWallet, message: s.message, signature: s.signature });
  });

  it("never asks the chain for a contract signature outside Base (sessions are not tied to a chain)", async () => {
    chainVerify.mockResolvedValue(true);
    const nonce = await issueNonce(db);
    const message = buildSignInMessage({ domain, uri, chainId: 84532, address: smartWallet, nonce });
    await expect(verifySignIn(db, { message, signature: "0xdeadbeef", domain })).rejects.toThrow(/Signature/);
    expect(chainVerify).not.toHaveBeenCalled();
  });

  it("rejects when the chain says it is invalid", async () => {
    const s = await smartSigned();
    await expect(verifySignIn(db, { ...s, domain })).rejects.toThrow(/Signature/);
    expect(chainVerify).toHaveBeenCalledTimes(1);
  });

  it("rejects when the chain lookup throws", async () => {
    chainVerify.mockRejectedValue(new Error("rpc down"));
    const s = await smartSigned();
    await expect(verifySignIn(db, { ...s, domain })).rejects.toThrow(/Signature/);
  });
});
