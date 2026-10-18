CREATE TABLE `event_sources` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fire_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name` ON `groups` (lower("name"));--> statement-breakpoint
CREATE TABLE `job_tags` (
	`job_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`job_id`, `tag`)
);
--> statement-breakpoint
CREATE INDEX `job_tags_tag` ON `job_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `job_upstreams` (
	`job_id` text NOT NULL,
	`upstream_id` text NOT NULL,
	PRIMARY KEY(`job_id`, `upstream_id`)
);
--> statement-breakpoint
CREATE INDEX `job_upstreams_upstream` ON `job_upstreams` (`upstream_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`paused_reason` text,
	`group_id` text,
	`event_source` text,
	`workflow_id` text,
	`next_fire_at` integer,
	`last_fired_at` integer,
	`last_success_at` integer,
	`fire_count` integer NOT NULL,
	`consecutive_failures` integer NOT NULL,
	`success_deadline` integer,
	`sla_breached_at` integer,
	`scheduler_owner` text,
	`scheduler_until` integer,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`enabled`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `jobs_group` ON `jobs` (`group_id`);--> statement-breakpoint
CREATE INDEX `jobs_name` ON `jobs` (`name`);--> statement-breakpoint
CREATE INDEX `jobs_success_deadline` ON `jobs` (`success_deadline`);--> statement-breakpoint
CREATE INDEX `jobs_event_source` ON `jobs` (`event_source`) WHERE "jobs"."event_source" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `notifications_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`run_id` text,
	`status` text NOT NULL,
	`available_at` integer NOT NULL,
	`lease_worker` text,
	`lease_until` integer,
	`attempts` integer NOT NULL,
	`last_error` text,
	`delivered_at` integer,
	`rule_index` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_key` ON `notifications_outbox` (`key`);--> statement-breakpoint
CREATE INDEX `outbox_due` ON `notifications_outbox` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `outbox_expired_leases` ON `notifications_outbox` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `outbox_run` ON `notifications_outbox` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`tokens` real,
	`refilled_at` integer,
	`running` integer NOT NULL,
	`touched_at` integer
);
--> statement-breakpoint
CREATE TABLE `run_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`job_id` text NOT NULL,
	`target_type` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` real,
	`status_code` integer,
	`attempts` integer NOT NULL,
	`late` integer NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `metrics_ts` ON `run_metrics` (`ts`);--> statement-breakpoint
CREATE INDEX `metrics_job_ts` ON `run_metrics` (`job_id`,`ts`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`available_at` integer,
	`started_at` integer,
	`lease_worker` text,
	`lease_until` integer,
	`cancel_requested` integer NOT NULL,
	`idempotency_key` text,
	`overlap_slot` text,
	`finished_at` integer,
	`late` integer NOT NULL,
	`late_reasons` text NOT NULL,
	`sla_deadline` integer,
	`sla_max_duration_ms` integer,
	`acknowledged_at` integer,
	`rate_limit_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_idempotency` ON `runs` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_overlap_slot` ON `runs` (`overlap_slot`);--> statement-breakpoint
CREATE INDEX `runs_claimable` ON `runs` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `runs_expired_leases` ON `runs` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `runs_job` ON `runs` (`job_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `runs_scheduled_at` ON `runs` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `runs_failed_inbox` ON `runs` (`status`,`acknowledged_at`,`id`);--> statement-breakpoint
CREATE INDEX `runs_rate_limit_slot` ON `runs` (`rate_limit_key`,`status`);--> statement-breakpoint
CREATE INDEX `runs_sla_deadline` ON `runs` (`sla_deadline`);--> statement-breakpoint
CREATE INDEX `runs_retention` ON `runs` (`finished_at`);--> statement-breakpoint
CREATE TABLE `schedule_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_job_recent` ON `schedule_decisions` (`job_id`,`at`);--> statement-breakpoint
CREATE INDEX `decisions_at` ON `schedule_decisions` (`at`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text,
	`has_queued` integer NOT NULL,
	`approval_deadline` integer,
	`version` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_idempotency` ON `workflow_runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow` ON `workflow_runs` (`workflow_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status` ON `workflow_runs` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_approval_deadline` ON `workflow_runs` (`approval_deadline`);--> statement-breakpoint
CREATE INDEX `workflow_runs_queued` ON `workflow_runs` (`has_queued`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`next_fire_at` integer,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflows_due` ON `workflows` (`enabled`,`next_fire_at`);