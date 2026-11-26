import { describe, expect, it } from "vitest";
import { getChatModel } from "./model";

describe("getChatModel", () => {
  it("never falls back to the scripted demo in a real deploy", () => {
    expect(() => getChatModel({ env: { NODE_ENV: "production" } })).toThrow(/no model key/);
    expect(() => getChatModel({ env: { NODE_ENV: "production", LLM_PROVIDER: "other", ANTHROPIC_API_KEY: "k" } })).toThrow(/LLM_PROVIDER/);
  });

  it("uses Anthropic when a key is set, and the scripted model only under MOCK", () => {
    expect(getChatModel({ env: { NODE_ENV: "production", ANTHROPIC_API_KEY: "k" } })).toMatchObject({ provider: expect.stringContaining("anthropic") });
    expect(getChatModel({ env: { NODE_ENV: "production", MOCK: "1" } })).toMatchObject({ provider: "mock-provider" });
    expect(getChatModel({ env: { MOCK: "1", MOCK_LLM: "anthropic" } })).toMatchObject({ provider: "mock-provider" }); // no key: still scripted
    expect(getChatModel({ env: { MOCK: "1", MOCK_LLM: "anthropic", ANTHROPIC_API_KEY: "k" } })).toMatchObject({ provider: expect.stringContaining("anthropic") });
    expect(() => getChatModel({ env: { NODE_ENV: "test" } })).toThrow(/no model key/);
  });
});
