/**
 * Bring the database up to the schema, on start.
 *
 * The migrations are the SQL files drizzle-kit generated into `../drizzle/`;
 * drizzle's migrator applies the ones the ledger has not seen, in order. It
 * runs before the server listens, under a Postgres advisory lock keyed by
 * the ledger name, so two replicas starting together take turns rather than
 * both racing the same `CREATE TABLE`. That is the looped apps' arrangement
 * (`packages/db/src/migrate.ts` in the mono), trimmed to one database.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

export const LEDGER = { migrationsTable: "plans_migrations", migrationsSchema: "drizzle" };
const FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** A stable 32-bit key from the ledger name: the advisory lock's id. */
function lockKey(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return h;
}

/** Postgres proper, through a pg Pool. */
export async function migratePg(pool) {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey(LEDGER.migrationsTable)]);
    try {
      await migrate(drizzle(client), { migrationsFolder: FOLDER, ...LEDGER });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey(LEDGER.migrationsTable)]);
    }
  } finally {
    client.release();
  }
}

/** The in-process Postgres: same SQL, same ledger, no lock to take. */
export async function migratePglite(lite) {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(drizzle(lite), { migrationsFolder: FOLDER, ...LEDGER });
}
