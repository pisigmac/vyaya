#!/usr/bin/env node
/**
 * Dev/e2e Postgres runner: starts a real user-space Postgres 16 via the
 * @vyaya/db test-support harness (embedded-postgres binaries — no docker,
 * no sudo) and keeps it alive until SIGTERM/SIGINT.
 *
 * Usage: node scripts/dev-pg.mjs <ready-file>
 *   Writes {"url","port"} JSON to <ready-file> once the database accepts
 *   connections, then waits. On shutdown the cluster is stopped and its
 *   temp data dir removed.
 */

import { writeFileSync } from "node:fs";
import { startEmbeddedPostgres } from "../packages/db/dist/test-support/embedded-pg.js";

const readyFile = process.argv[2];
if (!readyFile) {
  console.error("usage: node scripts/dev-pg.mjs <ready-file>");
  process.exit(2);
}

const handle = await startEmbeddedPostgres();
writeFileSync(
  readyFile,
  JSON.stringify({ url: handle.url, port: handle.port }) + "\n",
);
console.log(`postgres ready on port ${handle.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await handle.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 60_000);
