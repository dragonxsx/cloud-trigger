CREATE TABLE `connection_environments` (
	`connection_key` text NOT NULL,
	`environment` text NOT NULL,
	PRIMARY KEY(`connection_key`, `environment`)
);
--> statement-breakpoint
CREATE INDEX `connection_environments_environment` ON `connection_environments` (`environment`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_key` ON `environments` (`key`);--> statement-breakpoint
ALTER TABLE `groups` ADD `environment` text;--> statement-breakpoint
CREATE INDEX `groups_environment` ON `groups` (`environment`) WHERE "groups"."environment" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `environment` text;--> statement-breakpoint
CREATE INDEX `jobs_environment` ON `jobs` (`environment`) WHERE "jobs"."environment" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `environment` text;--> statement-breakpoint
CREATE INDEX `workflows_environment` ON `workflows` (`environment`) WHERE "workflows"."environment" IS NOT NULL;