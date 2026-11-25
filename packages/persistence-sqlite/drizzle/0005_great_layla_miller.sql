ALTER TABLE `workflow_runs` ADD `finished_at` integer;--> statement-breakpoint
CREATE INDEX `workflow_runs_finished` ON `workflow_runs` (`finished_at`) WHERE "workflow_runs"."finished_at" IS NOT NULL;