/**
 * The workspace server: one process, one SQLite file, one websocket per open
 * document. See ../README.md for what it is for and how to run it.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { openDb } from "./db.js";
import { makeAuth, httpError, isLogin } from "./auth.js";
import { Rooms } from "./rooms.js";

export function startServer({
  port = Number(process.env.PORT ?? 8787),
  host = process.env.HOST ?? "127.0.0.1",
  /** Postgres; empty means an in-process one, for a laptop or a test. */
  databaseUrl = process.env.DATABASE_URL ?? "",
  /** The Auth0 tenant and the native application sign-in goes through. */
  domain = process.env.AUTH0_DOMAIN ?? "",
  clientId = process.env.AUTH0_CLIENT_ID ?? "",
  devLogin = process.env.WORKSPACES_DEV_LOGIN === "1",
  fetchImpl = fetch,
} = {}) {
  /** Resolved before `ready`; every handler awaits it through `dbReady`. */
  let db;
  const rooms = new Rooms();
  const dbReady = openDb(databaseUrl).then((d) => {
    db = d;
    rooms.db = d;
  });
  const auth = makeAuth({
    // The auth module only ever calls these after the database is up.
    db: {
      upsertUser: (...a) => db.upsertUser(...a),
      createSession: (...a) => db.createSession(...a),
    },
    domain,
    clientId,
    devLogin,
    fetchImpl,
  });
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
  const who = async (req) => {
    const login = await db.loginFor(bearer(req));
    if (!login) throw httpError(401, "sign in first");
    return login;
  };
  /** A workspace the caller belongs to, or a 404 — never a 403, which would
   *  confirm to a stranger that the id exists. */
  const mine = async (req, id) => {
    const login = await who(req);
    const w = await db.workspace(id);
    if (!w || !(await db.isMember(id, login))) throw httpError(404, "no such workspace");
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
      return json(res, 200, await auth.devSession(login));
    }
    if (req.method === "POST" && path === "/auth/signout") {
      await db.endSession(bearer(req));
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/me") {
      const login = await who(req);
      return json(res, 200, await db.user(login));
    }

    // --- workspaces --------------------------------------------------------
    if (req.method === "GET" && path === "/workspaces") {
      return json(res, 200, await db.workspacesFor(await who(req)));
    }
    if (req.method === "POST" && path === "/workspaces") {
      const login = await who(req);
      const { name } = await body(req);
      const clean = String(name ?? "").trim().slice(0, 120);
      if (!clean) throw httpError(400, "a workspace needs a name");
      return json(res, 201, await db.createWorkspace(clean, login));
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)$/)) && req.method === "GET") {
      return json(res, 200, (await mine(req, seg[1])).w);
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/members$/)) && req.method === "POST") {
      const { w } = await mine(req, seg[1]);
      const { login } = await body(req);
      if (!isLogin(login)) throw httpError(400, "not an email");
      await db.addMember(w.id, login.trim().toLowerCase());
      return json(res, 200, await db.workspace(w.id));
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/review$/)) && req.method === "POST") {
      const { login, w } = await mine(req, seg[1]);
      const { action } = await body(req);
      const r = await db.review(w.id, action, login);
      if (r.error) throw httpError(r.error, r.reason);
      rooms.announceReview(w.id, r.review);
      return json(res, 200, r.review);
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/token$/)) && req.method === "POST") {
      const { login, w } = await mine(req, seg[1]);
      return json(res, 201, { token: await db.createReadToken(w.id, login) });
    }
    // --- share links -------------------------------------------------------
    // Minting, listing and revoking are member-only, through the same `mine`
    // guard as everything else; the reading is below, behind the link's own
    // token. See plans/sharable-links.md.
    if ((seg = m(/^\/workspaces\/([\w-]+)\/share$/)) && req.method === "POST") {
      const { login, w } = await mine(req, seg[1]);
      return json(res, 201, await db.createShareToken(w.id, login));
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/share$/)) && req.method === "GET") {
      const { w } = await mine(req, seg[1]);
      return json(res, 200, await db.shareTokens(w.id));
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/share\/revoke$/)) && req.method === "POST") {
      const { w } = await mine(req, seg[1]);
      const { id } = await body(req);
      if (!(await db.revokeShareToken(w.id, String(id ?? "")))) throw httpError(404, "no such link");
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/share") {
      // The shell the fragment is read by: no id, no token, nothing of the
      // document. An unfurler fetching this link sees exactly this.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(viewerPage());
      return;
    }
    if (req.method === "GET" && path === "/share/doc") {
      // The token is the address: the workspace id is never in the URL.
      const id = await db.workspaceForShareToken(bearer(req));
      // Revoked, expired, and never-minted answer alike.
      if (!id) throw httpError(404, "this link is not a link any more");
      const w = await db.workspace(id);
      if (!w) throw httpError(404, "this link is not a link any more");
      return json(res, 200, {
        name: w.name,
        // The chip's state and nothing more: who asked, who decided and who is
        // in the room are not part of the document.
        review: { state: w.review.state },
        markdown: await rooms.markdown(id),
      });
    }
    if ((seg = m(/^\/w\/([\w-]+)\/plan\.md$/)) && req.method === "GET") {
      // Two doors: a member's session, or the per-workspace token that the
      // factory holds in its secrets. Both are bearer tokens; neither is the
      // URL.
      const id = seg[1];
      const t = bearer(req);
      const viaToken = (await db.workspaceForReadToken(t)) === id;
      const login = viaToken ? null : await db.loginFor(t);
      if (!viaToken && !(login && (await db.isMember(id, login)))) throw httpError(404, "no such workspace");
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(await rooms.markdown(id));
      return;
    }
    throw httpError(404, "not found");
  }

  // --- the live document -----------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url, "http://x");
      const seg = url.pathname.match(/^\/ws\/([\w-]+)$/);
      const login = await db.loginFor(url.searchParams.get("token"));
      // Membership is checked before the socket exists: a stranger gets a
      // closed connection and nothing about the room, not even its emptiness.
      if (!seg || !login || !(await db.isMember(seg[1], login))) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const w = await db.workspace(seg[1]);
      wss.handleUpgrade(req, socket, head, (ws) => {
        void rooms.join(seg[1], ws, w.review);
      });
    })().catch((e) => {
      console.error(e);
      socket.destroy();
    });
  });

  const ready = dbReady.then(
    () => new Promise((resolve) => server.listen(port, host, () => resolve())),
  );
  const close = async () => {
    await rooms.flush();
    for (const c of wss.clients) c.terminate();
    // Keep-alive connections would otherwise hold the process open.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  };

  return {
    ready,
    close,
    get port() {
      return server.address()?.port;
    },
    get db() {
      return db;
    },
    rooms,
  };
}

/**
 * The viewer, read once and held: one self-contained file, no build step and
 * no framework, so serving it is reading a string.
 */
let viewerHtml = null;
function viewerPage() {
  if (viewerHtml === null) viewerHtml = readFileSync(new URL("./share.html", import.meta.url), "utf8");
  return viewerHtml;
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
