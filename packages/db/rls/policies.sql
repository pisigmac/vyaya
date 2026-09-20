-- Vyaya row-level security and application roles.
--
-- Source of truth for RLS. This file is copied verbatim (after the
-- statement-breakpoint header) into drizzle/0001_rls_policies.sql when the
-- migration is authored; src/migrations.test.ts asserts the copy stays
-- byte-identical so the two can never drift.
--
-- Model
-- -----
-- Tenant isolation is enforced by Postgres, not by application discipline:
--   * ENABLE + FORCE ROW LEVEL SECURITY on every tenant table (the table
--     owner is subject too; only superusers bypass).
--   * Every policy compares the row's workspace_id (workspaces.id for the
--     tenant root) against the transaction-local GUC app.workspace_id.
--   * Application code sets it via `SET LOCAL app.workspace_id = '<uuid>'`
--     (see src/client.ts withWorkspace) inside every transaction.
--   * Unset or empty GUC => NULL => no rows visible, no writes allowed.
--
-- Roles
-- -----
--   * vyaya_app     — web/proxy hot path. NOLOGIN, non-BYPASSRLS. Tenant
--                     policies only; cannot enumerate other workspaces.
--   * vyaya_service — worker service role. NOLOGIN, non-BYPASSRLS. Same
--                     tenant policies, PLUS a read/write-everything policy
--                     on workspaces so nightly jobs can discover tenants.
--                     It must still SET LOCAL app.workspace_id per workspace
--                     before touching any tenant rows.
-- Both roles are NOLOGIN: deployments create a LOGIN role (or reuse the
-- owner) and GRANT these roles to it, then SET ROLE on connect. The final
-- GRANT block below grants them to whichever role runs the migration, so
-- the database owner can SET ROLE vyaya_app / vyaya_service immediately
-- (used by the seed script and the RLS tests). docs/DEPLOY.md documents
-- the production login mapping.

-- 1. Roles -------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vyaya_app') THEN
    CREATE ROLE vyaya_app NOLOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vyaya_service') THEN
    CREATE ROLE vyaya_service NOLOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO vyaya_app, vyaya_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vyaya_app, vyaya_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vyaya_app, vyaya_service;

DO $$
BEGIN
  EXECUTE format('GRANT vyaya_app TO %I', current_user);
  EXECUTE format('GRANT vyaya_service TO %I', current_user);
END
$$;

-- 2. GUC helper ----------------------------------------------------------------
-- current_setting(name, true) returns NULL when unset; NULLIF also maps an
-- explicitly-set empty string to NULL so the ::uuid cast cannot error and
-- an empty GUC behaves as "no tenant" (default deny).

CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

-- 3. Tenant root ---------------------------------------------------------------

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_self ON "workspaces"
  TO PUBLIC
  USING (id = app_current_workspace_id())
  WITH CHECK (id = app_current_workspace_id());

CREATE POLICY service_enumerate_workspaces ON "workspaces"
  TO vyaya_service
  USING (true)
  WITH CHECK (true);

-- 4. Tenant tables -------------------------------------------------------------
-- Identical policy shape for every table carrying workspace_id.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "users"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "api_keys"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "request_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "request_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "request_logs"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "request_bodies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "request_bodies" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "request_bodies"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "waste_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waste_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "waste_events"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "detector_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "detector_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "detector_runs"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "reports"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "feature_tag_allowlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_tag_allowlist" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "feature_tag_allowlist"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "stripe_meter_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_meter_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "stripe_meter_events"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
