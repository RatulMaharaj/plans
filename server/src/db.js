/**
 * Everything the server remembers, in one SQLite file.
 *
 * `node:sqlite` rather than a native module: the server is meant to be one
 * process you can run anywhere Node runs, and a build step for the database
 * driver is the first thing that would stop that being true.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    login TEXT PRIMARY KEY,
    name TEXT,
    avatar TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    review_state TEXT NOT NULL DEFAULT 'none',
    review_requested_by TEXT,
    review_decided_by TEXT,
    review_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS members (
    workspace_id TEXT NOT NULL,
    login TEXT NOT NULL,
    PRIMARY KEY (workspace_id, login)
  );
  CREATE TABLE IF NOT EXISTS docs (
    workspace_id TEXT PRIMARY KEY,
    state BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS read_tokens (
    token_hash TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

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

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const q = {
    upsertUser: db.prepare(
      `INSERT INTO users (login, name, avatar) VALUES (?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`,
    ),
    user: db.prepare("SELECT login, name, avatar FROM users WHERE login = ?"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, login, created_at) VALUES (?, ?, ?)"),
    session: db.prepare("SELECT login FROM sessions WHERE token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    insertWorkspace: db.prepare(
      "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
    ),
    workspace: db.prepare("SELECT * FROM workspaces WHERE id = ?"),
    workspacesFor: db.prepare(
      `SELECT w.* FROM workspaces w JOIN members m ON m.workspace_id = w.id
       WHERE m.login = ? ORDER BY w.created_at DESC`,
    ),
    addMember: db.prepare("INSERT OR IGNORE INTO members (workspace_id, login) VALUES (?, ?)"),
    members: db.prepare("SELECT login FROM members WHERE workspace_id = ? ORDER BY login"),
    isMember: db.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND login = ?"),
    setReview: db.prepare(
      `UPDATE workspaces SET review_state = ?, review_requested_by = ?, review_decided_by = ?, review_at = ?
       WHERE id = ?`,
    ),
    doc: db.prepare("SELECT state FROM docs WHERE workspace_id = ?"),
    saveDoc: db.prepare(
      `INSERT INTO docs (workspace_id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    ),
    insertReadToken: db.prepare(
      "INSERT INTO read_tokens (token_hash, workspace_id, created_by, created_at) VALUES (?, ?, ?, ?)",
    ),
    readToken: db.prepare("SELECT workspace_id FROM read_tokens WHERE token_hash = ?"),
  };

  const now = () => Date.now();

  return {
    close: () => db.close(),

    // --- people ------------------------------------------------------------
    upsertUser(login, name = null, avatar = null) {
      q.upsertUser.run(login, name, avatar);
      return q.user.get(login);
    },
    user: (login) => q.user.get(login) ?? null,
    /** Mint a session for a login; the token is returned once and never stored. */
    createSession(login) {
      const token = newToken();
      q.insertSession.run(hashToken(token), login, now());
      return token;
    },
    loginFor(token) {
      return token ? (q.session.get(hashToken(token))?.login ?? null) : null;
    },
    endSession(token) {
      q.deleteSession.run(hashToken(token));
    },

    // --- rooms -------------------------------------------------------------
    createWorkspace(name, login) {
      const id = newId();
      q.insertWorkspace.run(id, name, login, now());
      q.addMember.run(id, login);
      return this.workspace(id);
    },
    workspace(id) {
      const w = q.workspace.get(id);
      return w ? shape(w, q.members.all(id).map((m) => m.login)) : null;
    },
    workspacesFor(login) {
      return q.workspacesFor.all(login).map((w) => shape(w, q.members.all(w.id).map((m) => m.login)));
    },
    addMember(id, login) {
      q.addMember.run(id, login);
    },
    isMember: (id, login) => !!q.isMember.get(id, login),

    // --- review ------------------------------------------------------------
    /**
     * The one rule the clients cannot be trusted with: whoever asked for the
     * review cannot be the one who grants it.
     */
    review(id, action, login) {
      const w = q.workspace.get(id);
      if (!w) return { error: 404 };
      if (action === "request") {
        q.setReview.run("requested", login, null, now(), id);
      } else if (action === "approve" || action === "changes") {
        if (w.review_state !== "requested") return { error: 409, reason: "no review is open" };
        if (w.review_requested_by === login) {
          return { error: 403, reason: "the author cannot approve their own plan" };
        }
        q.setReview.run(action === "approve" ? "approved" : "changes", w.review_requested_by, login, now(), id);
      } else if (action === "clear") {
        q.setReview.run("none", null, null, now(), id);
      } else {
        return { error: 400, reason: `unknown action ${action}` };
      }
      return { review: this.workspace(id).review };
    },

    // --- the document ------------------------------------------------------
    loadDoc(id) {
      const row = q.doc.get(id);
      return row ? new Uint8Array(row.state) : null;
    },
    saveDoc(id, state) {
      q.saveDoc.run(id, Buffer.from(state), now());
    },

    // --- the read endpoint's key ------------------------------------------
    createReadToken(id, login) {
      const token = newToken();
      q.insertReadToken.run(hashToken(token), id, login, now());
      return token;
    },
    workspaceForReadToken(token) {
      return token ? (q.readToken.get(hashToken(token))?.workspace_id ?? null) : null;
    },
  };
}

function shape(w, members) {
  return {
    id: w.id,
    name: w.name,
    createdBy: w.created_by,
    createdAt: w.created_at,
    members,
    review: {
      state: w.review_state,
      requestedBy: w.review_requested_by,
      decidedBy: w.review_decided_by,
      at: w.review_at,
    },
  };
}
