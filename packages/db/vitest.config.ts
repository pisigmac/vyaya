import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Embedded Postgres initdb + boot takes seconds; migration and RLS
    // suites share one cluster per file and run serially within the file.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/test-support/**"],
    },
  },
});
