CREATE TABLE "event_sources" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"until" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fire_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_tags" (
	"job_id" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "job_tags_job_id_tag_pk" PRIMARY KEY("job_id","tag")
);
--> statement-breakpoint
CREATE TABLE "job_upstreams" (
	"job_id" text NOT NULL,
	"upstream_id" text NOT NULL,
	CONSTRAINT "job_upstreams_job_id_upstream_id_pk" PRIMARY KEY("job_id","upstream_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" integer NOT NULL,
	"paused_reason" text,
	"group_id" text,
	"event_source" text,
	"workflow_id" text,
	"next_fire_at" bigint,
	"last_fired_at" bigint,
	"last_success_at" bigint,
	"fire_count" integer NOT NULL,
	"consecutive_failures" integer NOT NULL,
	"success_deadline" bigint,
	"sla_breached_at" bigint,
	"scheduler_owner" text,
	"scheduler_until" bigint,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"run_id" text,
	"status" text NOT NULL,
	"available_at" bigint NOT NULL,
	"lease_worker" text,
	"lease_until" bigint,
	"attempts" integer NOT NULL,
	"last_error" text,
	"delivered_at" bigint,
	"rule_index" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision,
	"refilled_at" bigint,
	"running" integer NOT NULL,
	"touched_at" bigint
);
--> statement-breakpoint
CREATE TABLE "run_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"job_id" text NOT NULL,
	"target_type" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" double precision,
	"status_code" integer,
	"attempts" integer NOT NULL,
	"late" integer NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"scheduled_at" bigint NOT NULL,
	"available_at" bigint,
	"started_at" bigint,
	"lease_worker" text,
	"lease_until" bigint,
	"cancel_requested" integer NOT NULL,
	"idempotency_key" text,
	"overlap_slot" text,
	"finished_at" bigint,
	"late" integer NOT NULL,
	"late_reasons" text NOT NULL,
	"sla_deadline" bigint,
	"sla_max_duration_ms" bigint,
	"acknowledged_at" bigint,
	"rate_limit_key" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"at" bigint NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text,
	"has_queued" integer NOT NULL,
	"approval_deadline" bigint,
	"version" integer NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" integer NOT NULL,
	"next_fire_at" bigint,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name" ON "groups" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "job_tags_tag" ON "job_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "job_upstreams_upstream" ON "job_upstreams" USING btree ("upstream_id");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("enabled","next_fire_at");--> statement-breakpoint
CREATE INDEX "jobs_group" ON "jobs" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "jobs_name" ON "jobs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "jobs_success_deadline" ON "jobs" USING btree ("success_deadline");--> statement-breakpoint
CREATE INDEX "jobs_event_source" ON "jobs" USING btree ("event_source") WHERE "jobs"."event_source" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_key" ON "notifications_outbox" USING btree ("key");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "notifications_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_expired_leases" ON "notifications_outbox" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "outbox_run" ON "notifications_outbox" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "metrics_ts" ON "run_metrics" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "metrics_job_ts" ON "run_metrics" USING btree ("job_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency" ON "runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_overlap_slot" ON "runs" USING btree ("overlap_slot");--> statement-breakpoint
CREATE INDEX "runs_claimable" ON "runs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "runs_expired_leases" ON "runs" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "runs_job" ON "runs" USING btree ("job_id","status","id");--> statement-breakpoint
CREATE INDEX "runs_scheduled_at" ON "runs" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "runs_failed_inbox" ON "runs" USING btree ("status","acknowledged_at","id");--> statement-breakpoint
CREATE INDEX "runs_rate_limit_slot" ON "runs" USING btree ("rate_limit_key","status");--> statement-breakpoint
CREATE INDEX "runs_sla_deadline" ON "runs" USING btree ("sla_deadline");--> statement-breakpoint
CREATE INDEX "runs_retention" ON "runs" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "decisions_job_recent" ON "schedule_decisions" USING btree ("job_id","at");--> statement-breakpoint
CREATE INDEX "decisions_at" ON "schedule_decisions" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency" ON "workflow_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow" ON "workflow_runs" USING btree ("workflow_id","id");--> statement-breakpoint
CREATE INDEX "workflow_runs_status" ON "workflow_runs" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "workflow_runs_approval_deadline" ON "workflow_runs" USING btree ("approval_deadline");--> statement-breakpoint
CREATE INDEX "workflow_runs_queued" ON "workflow_runs" USING btree ("has_queued");--> statement-breakpoint
CREATE INDEX "workflows_due" ON "workflows" USING btree ("enabled","next_fire_at");