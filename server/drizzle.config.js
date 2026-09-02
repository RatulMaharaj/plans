/**
 * drizzle-kit's view of the server: where the schema is, where the SQL goes,
 * and which ledger records what has been applied — `drizzle.plans_migrations`,
 * the same shape as the looped apps, so a database shared with them one day
 * would not collide on the default `__drizzle_migrations`.
 *
 *   pnpm --filter plans-workspaces db:generate   # after editing src/schema.js
 *
 * `dbCredentials` is only read by `drizzle-kit migrate`/`push`; the server
 * itself applies the folder on start (src/migrate.js).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.js",
  out: "./drizzle",
  migrations: { table: "plans_migrations", schema: "drizzle" },
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost/plans" },
  strict: true,
  verbose: true,
});
