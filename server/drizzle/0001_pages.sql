CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"repo" text,
	"path" text,
	"markdown" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"published_by" text NOT NULL,
	"published_at" bigint NOT NULL,
	"revoked_at" bigint
);
