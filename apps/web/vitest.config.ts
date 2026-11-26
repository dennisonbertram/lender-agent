import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: new URL("./src/", import.meta.url).pathname }] },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    globalSetup: ["./tests/helpers/ensure-anvil.ts"],
    // Fork tests start anvil and read state from a public RPC.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
