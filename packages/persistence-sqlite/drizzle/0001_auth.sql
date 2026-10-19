CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `auth_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username_lower` text NOT NULL,
	`active_admin` integer NOT NULL,
	`version` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username` ON `users` (`username_lower`);