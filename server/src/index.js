/**
 * The workspace server: one process, one SQLite file, one websocket per open
 * document. See ../README.md for what it is for and how to run it.
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { openDb } from "./db.js";
import { makeAuth, httpError } from "./auth.js";
import { Rooms } from "./rooms.js";

export function startServer({
  port = Number(process.env.PORT ?? 8787),
  host = process.env.HOST ?? "127.0.0.1",
  dbPath = process.env.WORKSPACES_DB ?? "workspaces.sqlite",
  clientId = process.env.GITHUB_CLIENT_ID ?? "",
  devLogin = process.env.WORKSPACES_DEV_LOGIN === "1",
  fetchImpl = fetch,
} = {}) {
  const db = openDb(dbPath);
  const auth = makeAuth({ db, clientId, devLogin, fetchImpl });
  const rooms = new Rooms(db);

  const server = createServer(async (req, res) => {
    // The app's webview is another origin — tauri://localhost, or the dev
    // server — so every answer carries the headers that let it read them.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    try {
      await route(req, res);
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      json(res, status, { error: e.message ?? "error" });
    }
  });

  const bearer = (req) => {
    const h = req.headers.authorization ?? "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  };
  /** The signed-in login, or a 401. */
  const who = (req) => {
    const login = db.loginFor(bearer(req));
    if (!login) throw httpError(401, "sign in first");
    return login;
  };
  /** A workspace the caller belongs to, or a 404 — never a 403, which would
   *  confirm to a stranger that the id exists. */
  const mine = (req, id) => {
    const login = who(req);
    const w = db.workspace(id);
    if (!w || !db.isMember(id, login)) throw httpError(404, "no such workspace");
    return { login, w };
  };

  async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const m = (re) => path.match(re);
    let seg;

    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });

    // --- sign in -----------------------------------------------------------
    if (req.method === "POST" && path === "/auth/device") {
      return json(res, 200, await auth.startDevice());
    }
    if (req.method === "POST" && path === "/auth/device/poll") {
      const { deviceCode } = await body(req);
      return json(res, 200, await auth.pollDevice(deviceCode));
    }
    if (req.method === "POST" && path === "/auth/dev") {
      const { login } = await body(req);
      return json(res, 200, auth.devSession(login));
    }
    if (req.method === "POST" && path === "/auth/signout") {
      db.endSession(bearer(req));
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/me") {
      const login = who(req);
      return json(res, 200, db.user(login));
    }

    // --- workspaces --------------------------------------------------------
    if (req.method === "GET" && path === "/workspaces") {
      return json(res, 200, db.workspacesFor(who(req)));
    }
    if (req.method === "POST" && path === "/workspaces") {
      const login = who(req);
      const { name } = await body(req);
      const clean = String(name ?? "").trim().slice(0, 120);
      if (!clean) throw httpError(400, "a workspace needs a name");
      return json(res, 201, db.createWorkspace(clean, login));
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)$/)) && req.method === "GET") {
      return json(res, 200, mine(req, seg[1]).w);
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/members$/)) && req.method === "POST") {
      const { w } = mine(req, seg[1]);
      const { login } = await body(req);
      if (!/^[a-z0-9-]{1,39}$/i.test(login ?? "")) throw httpError(400, "not a GitHub login");
      db.addMember(w.id, login);
      return json(res, 200, db.workspace(w.id));
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/review$/)) && req.method === "POST") {
      const { login, w } = mine(req, seg[1]);
      const { action } = await body(req);
      const r = db.review(w.id, action, login);
      if (r.error) throw httpError(r.error, r.reason);
      rooms.announceReview(w.id, r.review);
      return json(res, 200, r.review);
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/token$/)) && req.method === "POST") {
      const { login, w } = mine(req, seg[1]);
      return json(res, 201, { token: db.createReadToken(w.id, login) });
    }
    if ((seg = m(/^\/w\/([\w-]+)\/plan\.md$/)) && req.method === "GET") {
      // Two doors: a member's session, or the per-workspace token that the
      // factory holds in its secrets. Both are bearer tokens; neither is the
      // URL.
      const id = seg[1];
      const t = bearer(req);
      const viaToken = db.workspaceForReadToken(t) === id;
      const login = viaToken ? null : db.loginFor(t);
      if (!viaToken && !(login && db.isMember(id, login))) throw httpError(404, "no such workspace");
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(rooms.markdown(id));
      return;
    }
    throw httpError(404, "not found");
  }

  // --- the live document -----------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const seg = url.pathname.match(/^\/ws\/([\w-]+)$/);
    const login = db.loginFor(url.searchParams.get("token"));
    // Membership is checked before the socket exists: a stranger gets a
    // closed connection and nothing about the room, not even its emptiness.
    if (!seg || !login || !db.isMember(seg[1], login)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      rooms.join(seg[1], ws, db.workspace(seg[1]).review);
    });
  });

  const ready = new Promise((resolve) => server.listen(port, host, () => resolve()));
  const close = () =>
    new Promise((resolve) => {
      rooms.flush();
      for (const c of wss.clients) c.terminate();
      // Keep-alive connections would otherwise hold the process open.
      server.closeAllConnections();
      server.close(() => {
        db.close();
        resolve();
      });
    });

  return {
    ready,
    close,
    get port() {
      return server.address()?.port;
    },
    db,
    rooms,
  };
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_000_000) throw httpError(413, "too large");
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "not JSON");
  }
}

// Started directly rather than imported: run it.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const s = startServer();
  await s.ready;
  console.log(`workspaces listening on ${process.env.HOST ?? "127.0.0.1"}:${s.port}`);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => void s.close().then(() => process.exit(0)));
  }
}
