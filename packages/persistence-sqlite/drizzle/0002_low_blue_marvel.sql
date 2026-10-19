CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_key` ON `connections` (`key`);--> statement-breakpoint
CREATE INDEX `connections_type` ON `connections` (`type`,`key`);--> statement-breakpoint
CREATE TABLE `job_connections` (
	`job_id` text NOT NULL,
	`connection_key` text NOT NULL,
	`endpoint_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_connections_job` ON `job_connections` (`job_id`,`connection_key`,`endpoint_key`);--> statement-breakpoint
CREATE INDEX `job_connections_connection` ON `job_connections` (`connection_key`,`endpoint_key`);