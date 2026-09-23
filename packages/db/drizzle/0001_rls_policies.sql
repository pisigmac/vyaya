-- Custom migration: row-level security, application roles, GUC helper.
-- The statements in this file are copied verbatim from rls/policies.sql
-- (the source of truth); src/migrations.test.ts asserts the copy stays in
-- sync. Edit rls/policies.sql first, then refresh this file.

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
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO vyaya_app, vyaya_service;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vyaya_app, vyaya_service;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vyaya_app, vyaya_service;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT vyaya_app TO %I', current_user);
  EXECUTE format('GRANT vyaya_service TO %I', current_user);
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_self ON "workspaces"
  TO PUBLIC
  USING (id = app_current_workspace_id())
  WITH CHECK (id = app_current_workspace_id());
--> statement-breakpoint
CREATE POLICY service_enumerate_workspaces ON "workspaces"
  TO vyaya_service
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "users"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "api_keys"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "request_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "request_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "request_logs"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "request_bodies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "request_bodies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "request_bodies"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "waste_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waste_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "waste_events"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "detector_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "detector_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "detector_runs"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "reports"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "feature_tag_allowlist" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "feature_tag_allowlist" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "feature_tag_allowlist"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "stripe_meter_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stripe_meter_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "stripe_meter_events"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
