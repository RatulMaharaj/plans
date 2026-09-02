ALTER TABLE "docs" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "kind" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
UPDATE "docs" SET "id" = replace(gen_random_uuid()::text, '-', '') WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "docs" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" DROP CONSTRAINT "docs_pkey";--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_pkey" PRIMARY KEY("id");--> statement-breakpoint
CREATE INDEX "docs_by_workspace" ON "docs" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_state";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_requested_by";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_decided_by";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "review_at";
