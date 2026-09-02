CREATE TABLE "docs" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"workspace_id" text NOT NULL,
	"login" text NOT NULL,
	CONSTRAINT "members_workspace_id_login_pk" PRIMARY KEY("workspace_id","login")
);
--> statement-breakpoint
CREATE TABLE "read_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "share_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"login" text PRIMARY KEY NOT NULL,
	"name" text,
	"avatar" text
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"review_state" text DEFAULT 'none' NOT NULL,
	"review_requested_by" text,
	"review_decided_by" text,
	"review_at" bigint
);
