-- Custom migration: RLS for the Stage-4b worker tables (daily_aggregates,
-- reconciliation_cursor, user_grants_cache). Copied verbatim from
-- rls/policies-worker.sql (the source of truth); src/migrations.test.ts
-- asserts the copy stays in sync. Edit rls/policies-worker.sql first.

ALTER TABLE "daily_aggregates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "daily_aggregates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON "daily_aggregates"
  TO PUBLIC
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "reconciliation_cursor" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reconciliation_cursor" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY service_reconciliation_cursor ON "reconciliation_cursor"
  TO vyaya_service
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "user_grants_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_grants_cache" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_grants_cache_read ON "user_grants_cache"
  FOR SELECT
  TO PUBLIC
  USING (true);
--> statement-breakpoint
CREATE POLICY user_grants_cache_write ON "user_grants_cache"
  TO vyaya_service
  USING (true)
  WITH CHECK (true);
