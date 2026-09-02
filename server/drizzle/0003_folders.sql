DROP INDEX "pages_live_workspace";--> statement-breakpoint
-- One row per document now, not one per workspace. The old primary key was
-- the workspace; rows from before folders are each a workspace's one file,
-- and get an id before the id becomes the key. (drizzle-kit could not name
-- the constraint itself; the initial migration created it as docs_pkey.)
ALTER TABLE "docs" DROP CONSTRAINT "docs_pkey";--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "id" text;--> statement-breakpoint
UPDATE "docs" SET "id" = substr(md5(random()::text || "workspace_id"), 1, 16) WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "docs" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "kind" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "path" text;--> statement-breakpoint
CREATE INDEX "docs_by_workspace" ON "docs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_live_workspace" ON "pages" USING btree ("workspace_id","path") WHERE revoked_at IS NULL AND workspace_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_state";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_requested_by";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_decided_by";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_at";