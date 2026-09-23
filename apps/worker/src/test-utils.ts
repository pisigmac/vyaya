import {
  closeDb,
  createDb,
  runMigrations,
  runSeed,
  type DbHandle,
} from "@vyaya/db";
import { startEmbeddedPostgres, type EmbeddedPg } from "@vyaya/db/test-support/embedded-pg";
import { pino } from "pino";

/** Shared helpers for worker tests (embedded Postgres + seeded fixtures). */

export const silentLogger = pino({ level: "silent" });

/** Deterministic 32-byte dev key (matches .env.example's all-zero pattern). */
export const MASTER_KEY_HEX = "00".repeat(32);

/** Fixed reference clock shared by seed data and detector runs. */
export const SEED_NOW_MS = Date.UTC(2026, 8, 23, 12, 0, 0); // 2026-09-23 Wed

export interface SeededDb {
  cluster: EmbeddedPg;
  db: DbHandle;
  close(): Promise<void>;
}

/** Fresh embedded Postgres with migrations + the dev seed applied. */
export async function setupSeededDb(): Promise<SeededDb> {
  const cluster = await startEmbeddedPostgres();
  await runMigrations(cluster.url);
  await runSeed({
    databaseUrl: cluster.url,
    masterKeyHex: MASTER_KEY_HEX,
    nowMs: SEED_NOW_MS,
  });
  const db = createDb({ databaseUrl: cluster.url, maxConnections: 4 });
  return {
    cluster,
    db,
    async close() {
      await closeDb(db);
      await cluster.stop();
    },
  };
}

/**
 * A second seeded database inside an existing cluster — cheaper than
 * booting another Postgres (the crash-resume test needs two independent
 * seeded databases, not two clusters).
 */
export async function addSeededDatabase(
  cluster: EmbeddedPg,
  name: string,
): Promise<DbHandle> {
  await cluster.pg.createDatabase(name);
  const url = `postgres://vyaya:vyaya@127.0.0.1:${cluster.port}/${name}`;
  await runMigrations(url);
  await runSeed({ databaseUrl: url, masterKeyHex: MASTER_KEY_HEX, nowMs: SEED_NOW_MS });
  return createDb({ databaseUrl: url, maxConnections: 4 });
}

/** Fresh embedded Postgres with migrations only (no seed rows). */
export async function setupBareDb(): Promise<SeededDb> {
  const cluster = await startEmbeddedPostgres();
  await runMigrations(cluster.url);
  const db = createDb({ databaseUrl: cluster.url, maxConnections: 4 });
  return {
    cluster,
    db,
    async close() {
      await closeDb(db);
      await cluster.stop();
    },
  };
}
