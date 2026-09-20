import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // Embedded-Postgres clusters are heavy and the sandbox gate runs every
    // package's suite concurrently on 2 CPUs; the proxy's p95 latency gate
    // flakes under extra load (see STAGE4B notes). One worker keeps the web
    // footprint to a single live cluster at a time.
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts"],
    },
  },
});
