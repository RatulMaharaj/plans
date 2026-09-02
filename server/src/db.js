/**
 * Everything the server remembers, in Postgres.
 *
 * One database of its own on the shared looped server, reached through
 * `DATABASE_URL`. Without that variable — a laptop, the tests — the same SQL
 * runs against PGlite, a Postgres in the process: one dialect, one schema,
 * and nothing to install to run the suite. The only thing the two share is
 * `query(sql, params)`, which is all this module asks of either.
 *
 * The shape of the tables is `schema.js`, and the SQL that builds them is
 * generated from it into `../drizzle/` and applied on open (migrate.js).
 * Nothing here creates a table. A workspace used to be one document keyed by
 * the workspace's id and a review state on the row; it is now a tree of
 * documents keyed by their own ids, and the review gate is gone — `status:`
 * in the file says what it said. `0001_workspace_folders.sql` is that change:
 * the `docs` rows written by the old build keep their bytes and are given
 * ids, and the tree naming one of them `plan.md` is written by the server the
 * first time anybody asks for that workspace's tree.
 */
import { randomBytes, createHash } from "node:crypto";

import { migratePg, migratePglite } from "./migrate.js";

/**
 * How long a share link lives without anyone thinking about it.
 *
 * Revocation answers the leaked link; this answers the *forgotten* one, since
 * nobody revokes what they no longer remember minting. Expired and revoked are
 * indistinguishable from outside — both are 404.
 */
const SHARE_TTL = 30 * 24 * 60 * 60 * 1000;

/** Tokens are stored hashed: a leaked database is not a leaked session. */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken() {
  return randomBytes(32).toString("base64url");
}

/** Short, URL-safe, and not guessable in bulk. */
export function newId() {
  return randomBytes(9).toString("base64url");
}

/** A migrated `query(sql, params) -> rows` over whichever Postgres is available. */
async function connect(url) {
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url });
    await migratePg(pool);
    return {
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite();
  await lite.waitReady;
  await migratePglite(lite);
  return {
    query: async (sql, params = []) => (await lite.query(sql, params)).rows,
    close: () => lite.close(),
  };
}

export async function openDb(url = process.env.DATABASE_URL ?? "") {
  const c = await connect(url);

  const one = async (sql, params) => (await c.query(sql, params))[0] ?? null;
  const now = () => Date.now();

  const shape = (w, members) => ({
    id: w.id,
    name: w.name,
    createdBy: w.created_by,
    createdAt: Number(w.created_at),
    members,
  });
  const membersOf = async (id) =>
    (await c.query("SELECT login FROM members WHERE workspace_id = $1 ORDER BY login", [id])).map(
      (m) => m.login,
    );

  return {
    close: () => c.close(),

    // --- people ------------------------------------------------------------
    async upsertUser(login, name = null, avatar = null) {
      return one(
        `INSERT INTO users (login, name, avatar) VALUES ($1, $2, $3)
         ON CONFLICT (login) DO UPDATE SET name = EXCLUDED.name, avatar = EXCLUDED.avatar
         RETURNING login, name, avatar`,
        [login, name, avatar],
      );
    },
    user: (login) => one("SELECT login, name, avatar FROM users WHERE login = $1", [login]),
    /** Mint a session for a login; the token is returned once and never stored. */
    async createSession(login) {
      const token = newToken();
      await c.query("INSERT INTO sessions (token_hash, login, created_at) VALUES ($1, $2, $3)", [
        hashToken(token),
        login,
        now(),
      ]);
      return token;
    },
    async loginFor(token) {
      if (!token) return null;
      return (await one("SELECT login FROM sessions WHERE token_hash = $1", [hashToken(token)]))?.login ?? null;
    },
    endSession: (token) =>
      token ? c.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]) : null,

    // --- rooms -------------------------------------------------------------
    async createWorkspace(name, login) {
      const id = newId();
      await c.query(
        "INSERT INTO workspaces (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)",
        [id, name, login, now()],
      );
      await this.addMember(id, login);
      return this.workspace(id);
    },
    async workspace(id) {
      const w = await one("SELECT * FROM workspaces WHERE id = $1", [id]);
      return w ? shape(w, await membersOf(id)) : null;
    },
    async workspacesFor(login) {
      const rows = await c.query(
        `SELECT w.* FROM workspaces w JOIN members m ON m.workspace_id = w.id
         WHERE m.login = $1 ORDER BY w.created_at DESC`,
        [login],
      );
      return Promise.all(rows.map(async (w) => shape(w, await membersOf(w.id))));
    },
    addMember: (id, login) =>
      c.query("INSERT INTO members (workspace_id, login) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, login]),
    isMember: async (id, login) =>
      !!(await one("SELECT 1 AS ok FROM members WHERE workspace_id = $1 AND login = $2", [id, login])),

    // --- the documents -----------------------------------------------------
    /**
     * Which workspace a room belongs to, and whether it is that workspace's
     * tree or one of its files. This is what the websocket's membership check
     * is made of: a document is reachable by whoever is in the workspace that
     * owns it, and by nobody else.
     */
    doc: (id) => one("SELECT id, workspace_id, kind FROM docs WHERE id = $1", [id]),
    /** Every document of a workspace, oldest first; `kind` narrows it. */
    docsFor: (workspaceId, kind = null) =>
      c.query(
        `SELECT id, workspace_id, kind FROM docs
         WHERE workspace_id = $1 AND ($2::text IS NULL OR kind = $2)
         ORDER BY updated_at`,
        [workspaceId, kind],
      ),
    async loadDoc(id) {
      const row = await one("SELECT state FROM docs WHERE id = $1", [id]);
      return row ? new Uint8Array(row.state) : null;
    },
    saveDoc: (id, workspaceId, kind, state) =>
      c.query(
        `INSERT INTO docs (id, workspace_id, kind, state, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        [id, workspaceId, kind, Buffer.from(state), now()],
      ),
    dropDoc: (id) => c.query("DELETE FROM docs WHERE id = $1", [id]),

    // --- the read endpoint's key ------------------------------------------
    async createReadToken(id, login) {
      const token = newToken();
      await c.query(
        "INSERT INTO read_tokens (token_hash, workspace_id, created_by, created_at) VALUES ($1, $2, $3, $4)",
        [hashToken(token), id, login, now()],
      );
      return token;
    },
    async workspaceForReadToken(token) {
      if (!token) return null;
      return (
        (await one("SELECT workspace_id FROM read_tokens WHERE token_hash = $1", [hashToken(token)]))
          ?.workspace_id ?? null
      );
    },

    // --- share links -------------------------------------------------------
    /**
     * A table of its own rather than a `kind` column on `read_tokens`: the
     * factory's credential is minted once and lives in secrets, share links
     * are minted casually and revoked on a whim, and the list one UI shows
     * should never have the other in it. The reasoning is in
     * plans/sharable-links.md.
     */
    async createShareToken(workspaceId, login, path = "plan.md", ttl = SHARE_TTL) {
      const token = newToken();
      const id = newId();
      const at = now();
      await c.query(
        `INSERT INTO share_tokens (id, token_hash, workspace_id, created_by, created_at, expires_at, path)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, hashToken(token), workspaceId, login, at, at + ttl, path],
      );
      return { id, token, path, createdBy: login, createdAt: at, expiresAt: at + ttl };
    },
    /**
     * The live links, newest first. A revoked or expired one is nobody's
     * business: a list that showed dead links would invite counting them as
     * links.
     */
    async shareTokens(workspaceId) {
      const rows = await c.query(
        `SELECT id, created_by, created_at, expires_at, path FROM share_tokens
         WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > $2
         ORDER BY created_at DESC`,
        [workspaceId, now()],
      );
      return rows.map((r) => ({
        id: r.id,
        path: r.path ?? "plan.md",
        createdBy: r.created_by,
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
      }));
    },
    /** Revoking is a timestamp, not a delete: a dead link stays accounted for. */
    async revokeShareToken(workspaceId, id) {
      const rows = await c.query(
        `UPDATE share_tokens SET revoked_at = $1
         WHERE id = $2 AND workspace_id = $3 AND revoked_at IS NULL RETURNING id`,
        [now(), id, workspaceId],
      );
      return rows.length > 0;
    },
    /**
     * Kill every live link into a workspace at once.
     *
     * The token is per workspace even though a link names a file, so this is
     * what "the argument has left the room" costs: copying a plan out into a
     * repository revokes the links that were pointing at the room's copy of it.
     */
    async revokeShareTokens(workspaceId) {
      const rows = await c.query(
        `UPDATE share_tokens SET revoked_at = $1
         WHERE workspace_id = $2 AND revoked_at IS NULL RETURNING id`,
        [now(), workspaceId],
      );
      return rows.length;
    },
    /** Revoked, expired, or never minted here: all three answer `null`. */
    async shareTarget(token) {
      if (!token) return null;
      const row = await one(
        `SELECT workspace_id, path FROM share_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
        [hashToken(token), now()],
      );
      return row ? { workspaceId: row.workspace_id, path: row.path ?? "plan.md" } : null;
    },
  };
}
