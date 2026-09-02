/**
 * The tables, as drizzle sees them.
 *
 * This is the source of truth for the database's shape: `drizzle-kit
 * generate` diffs it against the last migration and writes the SQL for the
 * difference into `../drizzle/`, and the server applies that folder on
 * start (see migrate.js). The queries themselves stay as SQL in db.js —
 * there are a dozen of them and every one is plainer written out.
 */
import { pgTable, text, bigint, primaryKey, customType } from "drizzle-orm/pg-core";

/** `bytea`, which pg-core does not ship. The Yjs document is one of these. */
const bytea = customType({ dataType: () => "bytea" });

export const users = pgTable("users", {
  login: text("login").primaryKey(),
  name: text("name"),
  avatar: text("avatar"),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  login: text("login").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  reviewState: text("review_state").notNull().default("none"),
  reviewRequestedBy: text("review_requested_by"),
  reviewDecidedBy: text("review_decided_by"),
  reviewAt: bigint("review_at", { mode: "number" }),
});

export const members = pgTable(
  "members",
  {
    workspaceId: text("workspace_id").notNull(),
    login: text("login").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.login] })],
);

export const docs = pgTable("docs", {
  workspaceId: text("workspace_id").primaryKey(),
  state: bytea("state").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const readTokens = pgTable("read_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const shareTokens = pgTable("share_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  revokedAt: bigint("revoked_at", { mode: "number" }),
});
