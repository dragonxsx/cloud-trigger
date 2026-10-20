CREATE TABLE "connection_environments" (
	"connection_key" text NOT NULL,
	"environment" text NOT NULL,
	CONSTRAINT "connection_environments_connection_key_environment_pk" PRIMARY KEY("connection_key","environment")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"doc" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "environment" text;--> statement-breakpoint
CREATE INDEX "connection_environments_environment" ON "connection_environments" USING btree ("environment");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_key" ON "environments" USING btree ("key");--> statement-breakpoint
CREATE INDEX "groups_environment" ON "groups" USING btree ("environment") WHERE "groups"."environment" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_environment" ON "jobs" USING btree ("environment") WHERE "jobs"."environment" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflows_environment" ON "workflows" USING btree ("environment") WHERE "workflows"."environment" IS NOT NULL;