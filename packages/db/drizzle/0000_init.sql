CREATE TYPE "public"."detector_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('generated', 'emailed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('success', 'error', 'client_disconnect');--> statement-breakpoint
CREATE TYPE "public"."schema_validation_result" AS ENUM('passed', 'failed', 'not_requested');--> statement-breakpoint
CREATE TYPE "public"."stripe_meter_event_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."waste_type" AS ENUM('ghost_output', 'retry_storm', 'schema_failure_burn', 'context_amnesia', 'overprovisioned_max_tokens');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('admin', 'operator', 'viewer');--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"deskid_org_id" text,
	"log_bodies_enabled" boolean DEFAULT false NOT NULL,
	"detector_thresholds" jsonb,
	"wrapped_dek" jsonb,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deskid_sub" text NOT NULL,
	"email" text NOT NULL,
	"role" "workspace_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_deskid_sub_unique" UNIQUE("deskid_sub")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" text NOT NULL,
	"key_prefix" text DEFAULT 'vy_live' NOT NULL,
	"key_hash" text NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"request_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"model" text NOT NULL,
	"endpoint" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"max_tokens" integer,
	"cost_usd" numeric(14, 8) NOT NULL,
	"input_cost_usd" numeric(14, 8) NOT NULL,
	"output_cost_usd" numeric(14, 8) NOT NULL,
	"prompt_hash" text NOT NULL,
	"session_id" text,
	"feature_tag" text,
	"status" "request_status" NOT NULL,
	"schema_validation" "schema_validation_result" NOT NULL,
	"response_consumed" boolean DEFAULT true NOT NULL,
	"retry_attempt" integer DEFAULT 0 NOT NULL,
	"retry_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_bodies" (
	"request_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prompt_envelope" jsonb NOT NULL,
	"response_envelope" jsonb,
	"prompt_bytes" integer NOT NULL,
	"response_bytes" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waste_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"waste_type" "waste_type" NOT NULL,
	"request_ids" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"dollars_wasted" numeric(14, 8) NOT NULL,
	"evidence" jsonb NOT NULL,
	"detector_version" text NOT NULL,
	"suggested_fix" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"last_processed_log_id" text,
	"status" "detector_run_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"total_spend_usd" numeric(14, 8) NOT NULL,
	"dollars_wasted" numeric(14, 8) NOT NULL,
	"waste_rate" numeric(8, 6) NOT NULL,
	"top_waste_type" "waste_type",
	"biggest_event_id" uuid,
	"top_fix" text,
	"status" "report_status" DEFAULT 'generated' NOT NULL,
	"email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_tag_allowlist" (
	"workspace_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_tag_allowlist_workspace_id_tag_pk" PRIMARY KEY("workspace_id","tag")
);
--> statement-breakpoint
CREATE TABLE "stripe_meter_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" text,
	"event_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "stripe_meter_event_status" DEFAULT 'pending' NOT NULL,
	"stripe_event_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "stripe_meter_events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_bodies" ADD CONSTRAINT "request_bodies_request_id_request_logs_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_logs"("request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_bodies" ADD CONSTRAINT "request_bodies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_events" ADD CONSTRAINT "waste_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detector_runs" ADD CONSTRAINT "detector_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_biggest_event_id_waste_events_id_fk" FOREIGN KEY ("biggest_event_id") REFERENCES "public"."waste_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_tag_allowlist" ADD CONSTRAINT "feature_tag_allowlist_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_meter_events" ADD CONSTRAINT "stripe_meter_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_workspace_id_idx" ON "users" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_keys_active_workspace_idx" ON "api_keys" USING btree ("workspace_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "request_logs_workspace_occurred_idx" ON "request_logs" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "request_logs_workspace_hash_idx" ON "request_logs" USING btree ("workspace_id","prompt_hash","occurred_at");--> statement-breakpoint
CREATE INDEX "request_logs_workspace_session_idx" ON "request_logs" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "request_logs_workspace_tag_idx" ON "request_logs" USING btree ("workspace_id","feature_tag");--> statement-breakpoint
CREATE INDEX "request_bodies_workspace_expiry_idx" ON "request_bodies" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "waste_events_workspace_dedupe_idx" ON "waste_events" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "waste_events_workspace_type_detected_idx" ON "waste_events" USING btree ("workspace_id","waste_type","detected_at");--> statement-breakpoint
CREATE INDEX "detector_runs_workspace_started_idx" ON "detector_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_workspace_week_idx" ON "reports" USING btree ("workspace_id","week_start");--> statement-breakpoint
CREATE INDEX "stripe_meter_events_workspace_status_idx" ON "stripe_meter_events" USING btree ("workspace_id","status");