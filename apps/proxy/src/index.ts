import { serve } from "@hono/node-server";
import { loadProxyEnv } from "@vyaya/config";
import { createProxyApp } from "./app.js";
import { buildProxyRuntime } from "./deps.js";

/** CLI entry: validate env, wire dependencies, serve. */
async function main(): Promise<void> {
  const env = loadProxyEnv();
  const runtime = await buildProxyRuntime(env);
  const app = createProxyApp(runtime.deps);
  const logger = runtime.deps.logger;

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    logger.info({ port: info.port }, "vyaya-proxy listening");
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await runtime.close();
      process.exit(0);
    });
    // Never hang shutdown on a stuck connection.
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("proxy failed to start:", err);
  process.exit(1);
});
