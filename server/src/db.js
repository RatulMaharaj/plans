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
 * Nothing here creates a table.
 */
import { randomBytes, createHash } from "node:crypto";

import { migratePg, migratePglite } from "./migrate.js";

/**
 * What a database written by an older build is missing.
 *
 * Every statement is a no-op against a database `SCHEMA` just created, so the
 * two run in order on every start and neither needs to know which case it is
 * in. A workspace used to be one document keyed by the workspace's id and a
 * review state on the row; it is now a tree of documents keyed by their own
 * ids, and the review gate is gone — `status:` in the file says what it said.
 * The `docs` rows written by the old build are given ids by `openDb` below,
 * and the tree naming them is written by the server on first sight.
 */
const MIGRATIONS = [
  "ALTER TABLE docs ADD COLUMN IF NOT EXISTS id TEXT",
  "ALTER TABLE docs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file'",
  // The old primary key was the workspace, which is now one row per file.
  "ALTER TABLE docs DROP CONSTRAINT IF EXISTS docs_pkey",
  "CREATE UNIQUE INDEX IF NOT EXISTS docs_by_id ON docs (id)",
  "CREATE INDEX IF NOT EXISTS docs_by_workspace ON docs (workspace_id)",
  "ALTER TABLE workspaces DROP COLUMN IF EXISTS review_state",
  "ALTER TABLE workspaces DROP COLUMN IF EXISTS review_requested_by",
  "ALTER TABLE workspaces DROP COLUMN IF EXISTS review_decided_by",
  "ALTER TABLE workspaces DROP COLUMN IF EXISTS review_at",
  "ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS path TEXT",
];

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
  /** A page as everything above it speaks of one: a source, and a document. */
  const shapePage = (p) => ({
    id: p.id,
    source: p.workspace_id ? "workspace" : "repository",
    workspaceId: p.workspace_id,
    repo: p.repo,
    path: p.path,
    name: p.name,
    markdown: p.markdown,
    publishedBy: p.published_by,
    publishedAt: Number(p.published_at),
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
    /** Walk out. The creator cannot: a workspace with nobody to delete it
     *  would be a room that exists forever. */
    removeMember: (id, login) =>
      c.query("DELETE FROM members WHERE workspace_id = $1 AND login = $2", [id, login]),
    /**
     * Everything the workspace was: its documents, its members, its read and
     * share tokens, and its pages — the pages revoked rather than deleted,
     * so an address that was out there stays an honest 404.
     */
    async deleteWorkspace(id) {
      const t = now();
      await c.query("UPDATE pages SET revoked_at = $1 WHERE workspace_id = $2 AND revoked_at IS NULL", [t, id]);
      await c.query("DELETE FROM share_tokens WHERE workspace_id = $1", [id]);
      await c.query("DELETE FROM read_tokens WHERE workspace_id = $1", [id]);
      await c.query("DELETE FROM docs WHERE workspace_id = $1", [id]);
      await c.query("DELETE FROM members WHERE workspace_id = $1", [id]);
      await c.query("DELETE FROM workspaces WHERE id = $1", [id]);
    },
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
    // --- published pages ---------------------------------------------------
    /**
     * The page's id is the whole of its security, so it is longer than the
     * ids handed out elsewhere: 24 random bytes, which is not something a
     * crawler walks into. Everything else about a page is public to whoever
     * holds it.
     */
    async publishRepoPage(repo, path, markdown, name, login) {
      /*
       * Sharing the same file twice is sharing it once. The app remembers its
       * own pages, so this only happens when that memory is gone — a cleared
       * browser store, a reinstall — and handing back the address that is
       * already out there beats minting a second one nobody can stop.
       */
      const mine = await one(
        `SELECT * FROM pages
         WHERE repo = $1 AND path = $2 AND published_by = $3 AND revoked_at IS NULL`,
        [repo, path, login],
      );
      if (mine) return this.republishPage(mine.id, markdown, name);
      const id = randomBytes(24).toString("base64url");
      const at = now();
      await c.query(
        `INSERT INTO pages (id, repo, path, markdown, name, published_by, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, repo, path, markdown, name, login, at],
      );
      return this.page(id);
    },
    /**
     * A workspace document's page keeps no markdown — the page reads the room
     * — and there is only ever one live page per workspace: publishing a
     * second time hands back the first, so the URL a member shared stays the
     * URL. That is also what lets an old `/share#token` link resolve to a
     * page whether or not anyone has pressed Share.
     */
    async publishWorkspacePage(workspaceId, path, name, login) {
      const live = await this.workspacePage(workspaceId, path);
      if (live) return live;
      const id = randomBytes(24).toString("base64url");
      // The partial unique index on live workspace pages is the arbiter: a
      // second publisher racing this one loses the insert and is handed the
      // page the winner made, so both share the same URL.
      const rows = await c.query(
        `INSERT INTO pages (id, workspace_id, path, markdown, name, published_by, published_at)
         VALUES ($1, $2, $3, '', $4, $5, $6)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, workspaceId, path, name, login, now()],
      );
      return rows.length > 0 ? this.page(id) : this.workspacePage(workspaceId, path);
    },
    /** The same page, with what the file says now. Null if it is not live. */
    async republishPage(id, markdown, name) {
      const rows = await c.query(
        `UPDATE pages SET markdown = $1, name = COALESCE($2, name), published_at = $3
         WHERE id = $4 AND revoked_at IS NULL RETURNING id`,
        [markdown, name ?? null, now(), id],
      );
      return rows.length > 0 ? this.page(id) : null;
    },
    /** Revoked and never-published answer alike: null. */
    async page(id) {
      if (!id) return null;
      const r = await one("SELECT * FROM pages WHERE id = $1 AND revoked_at IS NULL", [id]);
      return r ? shapePage(r) : null;
    },
    async workspacePage(workspaceId, path) {
      const r = await one(
        "SELECT * FROM pages WHERE workspace_id = $1 AND path = $2 AND revoked_at IS NULL",
        [workspaceId, path],
      );
      return r ? shapePage(r) : null;
    },
    /** Kill every live link into a workspace at once: what copying out costs. */
    async revokeShareTokens(workspaceId) {
      const rows = await c.query(
        `UPDATE share_tokens SET revoked_at = $1
         WHERE workspace_id = $2 AND revoked_at IS NULL RETURNING id`,
        [now(), workspaceId],
      );
      return rows.length;
    },
    /** Stop sharing. A timestamp, so the address stays dead for good. */
    async revokePage(id) {
      const rows = await c.query(
        "UPDATE pages SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING id",
        [now(), id],
      );
      return rows.length > 0;
    },

    /** Revoked, expired, or never minted here: all three answer `null`. */
    async workspaceForShareToken(token) {
      if (!token) return null;
      return (
        (
          await one(
            `SELECT workspace_id FROM share_tokens
             WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
            [hashToken(token), now()],
          )
        )?.workspace_id ?? null
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
