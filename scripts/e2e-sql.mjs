#!/usr/bin/env node
/**
 * Tiny SQL helper for e2e scripts (no psql dependency).
 *
 * Usage: node scripts/e2e-sql.mjs <database-url> <sql> [--json]
 *   Prints rows as JSON lines (or a single JSON array with --json).
 *   Connects as whatever role the URL carries; the dev database user is a
 *   superuser, so RLS does not hide rows in these assertions.
 *
 * The `postgres` driver is resolved through @vyaya/db's node_modules so this
 * script has no dependencies of its own.
 */

import { createRequire } from "node:module";

const requireFromDb = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const postgres = requireFromDb("postgres");

const [, , databaseUrl, sql, flag] = process.argv;
if (!databaseUrl || !sql) {
  console.error("usage: node scripts/e2e-sql.mjs <database-url> <sql> [--json]");
  process.exit(2);
}

const client = postgres(databaseUrl, { max: 1 });
try {
  const rows = await client.unsafe(sql);
  if (flag === "--json") {
    console.log(JSON.stringify(rows));
  } else {
    for (const row of rows) console.log(JSON.stringify(row));
  }
} finally {
  await client.end();
}
