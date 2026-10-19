CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username_lower" text NOT NULL,
	"active_admin" integer NOT NULL,
	"version" integer NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username" ON "users" USING btree ("username_lower");