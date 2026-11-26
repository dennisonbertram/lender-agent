import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { activity } from "@/server/db/schema";
import { replyChunks } from "@/server/agent/model";
import { messages } from "@/server/db/schema";
import { loadThread } from "@/server/agent/persist";
import { ONLY_SUGGEST_TEXT } from "@/server/agent/honesty";
import { REDACTED_MESSAGE, looksLikeSecret } from "@/server/agent/secrets";
import { runChat } from "@/server/agent/run";
import { safeContext } from "@/server/request";
import { MOCK_OWNER, MOCK_SAFE } from "@/server/mock/seed";
import { createTestWorld, type TestWorld } from "../../../tests/helpers/world";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HEX = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

describe("looksLikeSecret", () => {
  it.each([
    MNEMONIC,
    `my phrase is ${MNEMONIC.toUpperCase()} ok`,
    HEX,
    `0x${HEX}`,
    `key: 0x${HEX}.`,
    "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
  ])("flags %s", (t) => expect(looksLikeSecret(t)).toBe(true));
  it.each([
    "I need $12k",
    "how does this work with abandon about",
    "0x" + "ab".repeat(20), // an address
    "a".repeat(64) + "g",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon", // 11 words
  ])("passes %s", (t) => expect(looksLikeSecret(t)).toBe(false));
});

describe("chat with a pasted secret", () => {
  let world: TestWorld;
  let safeId: number;
  let cookie: string;
  beforeEach(async () => {
    world = await createTestWorld();
    ({ cookie } = await world.signIn(MOCK_OWNER));
    safeId = await world.trackSafe(MOCK_SAFE, { agentAdded: true });
  });
  afterEach(() => world.reset());

  it.each([["mnemonic", MNEMONIC], ["hex key", `0x${HEX}`], ["bare hex key", HEX]])("a %s is not stored and not sent to the model", async (_n, secret) => {
    const seen: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        seen.push(JSON.stringify(prompt));
        return { stream: simulateReadableStream({ chunks: replyChunks({ text: "Here you go." }) }) };
      },
    });
    const ctx = await safeContext(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie }), MOCK_SAFE);
    const res = await runChat({ ctx, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: `here: ${secret}` }] }], model });
    const body = await res.text();
    expect(seen).toEqual([]);
    expect(body).not.toContain(secret);
    expect(body).toContain("never need a key or seed phrase");
    const stored = await loadThread(world.db, safeId);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain("abandon");
    expect(stored[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: REDACTED_MESSAGE }] });
    expect(stored[1]).toMatchObject({ role: "assistant", parts: [{ type: "text", text: ONLY_SUGGEST_TEXT }] });
    const rows = await world.db.select().from(activity);
    expect(rows.some((r) => r.actor === "Agent")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("a secret already in the stored thread is redacted on load and never reaches the model", async () => {
    await world.db.insert(messages).values({ id: "old1", safeId, role: "user", message: { id: "old1", role: "user", parts: [{ type: "text", text: `old ${MNEMONIC}` }] } });
    const loaded = await loadThread(world.db, safeId);
    expect(loaded[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: REDACTED_MESSAGE }] });
    const seen: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        seen.push(JSON.stringify(prompt));
        return { stream: simulateReadableStream({ chunks: replyChunks({ text: "Hello." }) }) };
      },
    });
    const ctx = await safeContext(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie }), MOCK_SAFE);
    const res = await runChat({ ctx, messages: [{ id: "u2", role: "user", parts: [{ type: "text", text: "hi" }] }], model });
    await res.text();
    expect(seen.length).toBe(1);
    expect(seen[0]).not.toContain("abandon");
    expect(seen[0]).toContain(REDACTED_MESSAGE);
  });
});
