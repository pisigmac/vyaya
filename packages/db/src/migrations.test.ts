import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  startEmbeddedPostgres,
  type EmbeddedPg,
} from "./test-support/embedded-pg.js";

const execFileAsync = promisify(execFile);
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const DRIZZLE_DIR = join(PKG_DIR, "drizzle");
const RLS_SOURCE = join(PKG_DIR, "rls", "policies.sql");
const RLS_MIGRATION = join(DRIZZLE_DIR, "0001_rls_policies.sql");
const RLS_WORKER_SOURCE = join(PKG_DIR, "rls", "policies-worker.sql");
const RLS_WORKER_MIGRATION = join(DRIZZLE_DIR, "0003_worker_service_rls.sql");

const TENANT_TABLES = [
  "workspaces",
  "users",
  "api_keys",
  "request_logs",
  "request_bodies",
  "waste_events",
  "detector_runs",
  "reports",
  "feature_tag_allowlist",
  "stripe_meter_events",
] as const;

/** Stage-4b tenant table (standard workspace_isolation policy). */
const WORKER_TENANT_TABLES = ["daily_aggregates"] as const;

/**
 * Stage-4b service-global tables: RLS enabled + forced, but policies are
 * role-scoped rather than workspace-GUC-scoped (see rls/policies-worker.sql).
 */
const SERVICE_TABLES = ["reconciliation_cursor", "user_grants_cache"] as const;

const ALL_TABLES = [...TENANT_TABLES, ...WORKER_TENANT_TABLES, ...SERVICE_TABLES];

/** Expected pg_policies per table (sorted), asserted exactly. */
const EXPECTED_POLICIES: Record<string, string[]> = {
  workspaces: ["service_enumerate_workspaces", "workspace_self"],
  reconciliation_cursor: ["service_reconciliation_cursor"],
  user_grants_cache: ["user_grants_cache_read", "user_grants_cache_write"],
};

function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        out[relative(dir, full)] = createHash("sha256")
          .update(readFileSync(full))
          .digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

/** SQL text of a migration chunk/source file with comment lines removed. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}


/** Assert a hand-written RLS migration is a verbatim copy of its rls/ source. */
function assertRlsSync(migrationPath: string, sourcePath: string): void {
  const migrationRaw = readFileSync(migrationPath, "utf8");
  const source = normalize(stripComments(readFileSync(sourcePath, "utf8")));

  const chunks = migrationRaw
    .split("--> statement-breakpoint")
    .map((chunk) => normalize(stripComments(chunk)))
    .filter((chunk) => chunk.length > 0);

  // Every migration statement appears verbatim in the source of truth.
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(
      source.includes(chunk),
      `migration statement missing from ${sourcePath}:\n${chunk}`,
    ).toBe(true);
  }

  // And the security-relevant statement counts match exactly, so a
  // statement deleted from only one of the two files fails this test.
  for (const keyword of [
    "CREATE POLICY",
    "ENABLE ROW LEVEL SECURITY",
    "FORCE ROW LEVEL SECURITY",
    "CREATE ROLE",
  ]) {
    const inSource = source.split(keyword).length - 1;
    const inMigration = chunks.join(" ").split(keyword).length - 1;
    expect(inMigration, keyword).toBe(inSource);
  }
}

describe("migrations", () => {
  let cluster: EmbeddedPg;
  let client: postgres.Sql;

  beforeAll(async () => {
    cluster = await startEmbeddedPostgres();
    await runMigrations(cluster.url);
    client = postgres(cluster.url, { max: 1, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await cluster?.stop();
  });

  it("applies cleanly on a fresh Postgres 16", async () => {
    const version = await client`SELECT version() AS v`;
    expect(version[0]?.v).toContain("PostgreSQL 16");

    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([...ALL_TABLES].sort());
  });

  it("is idempotent: a second migrate run applies nothing", async () => {
    await runMigrations(cluster.url);
    const rows = await client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`;
    expect(rows[0]?.count).toBe("5");
  });

  it("creates the app roles as non-superuser, non-BYPASSRLS, NOLOGIN", async () => {
    const roles = await client<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
    >`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
      WHERE rolname IN ('vyaya_app', 'vyaya_service') ORDER BY rolname`;
    expect(roles).toEqual([
      { rolname: "vyaya_app", rolsuper: false, rolbypassrls: false, rolcanlogin: false },
      { rolname: "vyaya_service", rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);
  });

  it("enables and forces RLS on every tenant table", async () => {
    const rows = await client<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...ALL_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} FORCE RLS`).toBe(true);
    }
  });

  it("installs exactly the expected policies on every table", async () => {
    const policies = await client<{ tablename: string; policyname: string }[]>`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public' ORDER BY tablename, policyname`;
    const byTable = new Map<string, string[]>();
    for (const p of policies) {
      const list = byTable.get(p.tablename) ?? [];
      list.push(p.policyname);
      byTable.set(p.tablename, list);
    }
    for (const table of ALL_TABLES) {
      const names = byTable.get(table) ?? [];
      expect(names, table).toEqual(EXPECTED_POLICIES[table] ?? ["workspace_isolation"]);
    }
    const fn = await client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_current_workspace_id'`;
    expect(fn[0]?.count).toBe("1");
  });

  it("has no schema drift: drizzle-kit generate produces no new migration", async () => {
    const before = snapshotDir(DRIZZLE_DIR);
    await execFileAsync("drizzle-kit", ["generate"], {
      cwd: PKG_DIR,
      env: process.env,
      timeout: 60_000,
    });
    const after = snapshotDir(DRIZZLE_DIR);
    expect(after).toEqual(before);
  }, 90_000);

  it("keeps drizzle/0001_rls_policies.sql in sync with rls/policies.sql", () => {
    assertRlsSync(RLS_MIGRATION, RLS_SOURCE);
  });

  it("keeps drizzle/0003_worker_service_rls.sql in sync with rls/policies-worker.sql", () => {
    assertRlsSync(RLS_WORKER_MIGRATION, RLS_WORKER_SOURCE);
  });
});
