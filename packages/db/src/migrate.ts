import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, createDb } from "./client.js";

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

/**
 * Apply every pending migration in drizzle/ to DATABASE_URL.
 * Used by the `pnpm --filter @vyaya/db migrate` script and by tests.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDb({ databaseUrl, maxConnections: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await closeDb(handle);
  }
}

// CLI entry: node dist/migrate.js
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { loadDbEnv } = await import("@vyaya/config");
  const env = loadDbEnv();
  await runMigrations(env.databaseUrl);
  console.log("migrations applied");
}
