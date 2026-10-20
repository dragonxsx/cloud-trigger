CREATE TABLE `group_connections` (
	`group_id` text NOT NULL,
	`connection_key` text NOT NULL,
	`endpoint_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_connections_group` ON `group_connections` (`group_id`,`connection_key`,`endpoint_key`);--> statement-breakpoint
CREATE INDEX `group_connections_connection` ON `group_connections` (`connection_key`,`endpoint_key`);