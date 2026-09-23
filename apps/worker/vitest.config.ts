import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 180_000,
    // The sandbox gate runs every package's suite concurrently on 2 CPUs;
    // cap fan-out so embedded-PG clusters don't starve sibling packages.
    maxWorkers: 2,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/test-utils.ts"],
    },
  },
});
