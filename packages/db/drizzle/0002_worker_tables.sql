CREATE TABLE "daily_aggregates" (
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_aggregates_workspace_id_day_pk" PRIMARY KEY("workspace_id","day")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_grants_cache" (
	"deskid_sub" text NOT NULL,
	"audience" text NOT NULL,
	"role" "workspace_role" NOT NULL,
	"email" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_grants_cache_deskid_sub_audience_pk" PRIMARY KEY("deskid_sub","audience")
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "pdf_path" text;--> statement-breakpoint
ALTER TABLE "daily_aggregates" ADD CONSTRAINT "daily_aggregates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
