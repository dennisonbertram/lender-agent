import { defineConfig } from "vitest/config";

// This focused suite must use real PostgreSQL sessions and does not need the
// normal suite's Anvil/fork global setup.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: new URL("./src/", import.meta.url).pathname }] },
  test: {
    environment: "node",
    include: ["tests/integration/*-postgres-locks.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
