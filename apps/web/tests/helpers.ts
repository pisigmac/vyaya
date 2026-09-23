import { createDb, runMigrations, runSeed } from "@vyaya/db";
import {
  startEmbeddedPostgres,
  type EmbeddedPg,
} from "@vyaya/db/test-support/embedded-pg";
import type { DbHandle } from "@vyaya/db/client";
import type { SessionPayload, VyayaRole } from "../lib/session";

/**
 * Shared embedded-Postgres fixture for the web BFF tests. One cluster per
 * test file, migrations applied, optionally seeded.
 */

export interface DbFixture {
  pg: EmbeddedPg;
  handle: DbHandle;
}

export async function startSeededDb(seed = true): Promise<DbFixture> {
  const pg = await startEmbeddedPostgres();
  await runMigrations(pg.url);
  if (seed) {
    // Master key present so the seed exercises the body-logging workspace
    // variant (workspace A gets logBodiesEnabled = true).
    await runSeed({
      databaseUrl: pg.url,
      masterKeyHex: "0".repeat(64),
    });
  }
  const handle = createDb({ databaseUrl: pg.url, maxConnections: 4 });
  return { pg, handle };
}

export async function stopDb(fixture: DbFixture): Promise<void> {
  await fixture.handle.client.end({ timeout: 5 });
  await fixture.pg.stop();
}

export const SEED_WORKSPACE_A = "00000000-0000-4000-a000-00000000000a";
export const SEED_WORKSPACE_B = "00000000-0000-4000-a000-00000000000b";
export const SEED_USER_A = "00000000-0000-4000-a000-0000000000a1";

export function makeSession(
  workspaceId: string,
  role: VyayaRole = "admin",
): SessionPayload {
  return {
    v: 1,
    sub: SEED_USER_A,
    email: "admin@acme.example",
    userId: SEED_USER_A,
    workspaceId,
    orgId: null,
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}
