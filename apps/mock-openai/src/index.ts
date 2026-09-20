import { serve } from "@hono/node-server";
import { loadMockOpenAiEnv } from "@vyaya/config";
import { createApp } from "./app.js";

/**
 * Entrypoint. All env access goes through @vyaya/config; behavior knobs are
 * documented in README.md and docs/ENV.md.
 */
const env = loadMockOpenAiEnv();
const app = createApp(env);

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(
    JSON.stringify({
      level: "info",
      service: "mock-openai",
      msg: "listening",
      port: info.port,
      seed: env.seed,
      latencyMs: env.latencyMs,
      failureRate: env.failureRate,
    }),
  );
});
