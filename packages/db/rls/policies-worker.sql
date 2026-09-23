-- Vyaya row-level security for the Stage-4b worker tables.
--
-- Companion to rls/policies.sql (which covers the Stage-2 tenant tables).
-- This file is the source of truth for RLS on the tables added in
-- drizzle/0002_worker_tables.sql; it is copied verbatim (after the
-- statement-breakpoint header) into drizzle/0003_worker_service_rls.sql
-- when the migration is authored. src/migrations.test.ts asserts both
-- copies stay byte-identical so the two can never drift.
--
-- Table model:
--   * daily_aggregates     — tenant table (workspace_id). Standard
--                            workspace_isolation policy, same shape as the
--                            Stage-2 tenant tables.
--   * reconciliation_cursor — service-global singleton (DeskId feed
--                            cursor). No workspace_id exists to scope by;
--                            only vyaya_service may read or write it.
--   * user_grants_cache    — service-global DeskId grant mirror. Any role
--                            may SELECT (the web app role reads grants for
--                            authorization decisions); only vyaya_service
--                            (the worker) may write.

ALTER TABLE "daily_aggregates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "daily_aggregates" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "daily_aggregates"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "reconciliation_cursor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reconciliation_cursor" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_reconciliation_cursor ON "reconciliation_cursor"
  TO vyaya_service
  USING (true)
  WITH CHECK (true);

ALTER TABLE "user_grants_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_grants_cache" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_grants_cache_read ON "user_grants_cache"
  FOR SELECT
  TO PUBLIC
  USING (true);
CREATE POLICY user_grants_cache_write ON "user_grants_cache"
  TO vyaya_service
  USING (true)
  WITH CHECK (true);
