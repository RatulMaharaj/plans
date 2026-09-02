/**
 * The workspace server: one process, one database, one websocket per open
 * document — and, since plans/public-plan-pages.md, the public reader too.
 *
 * Two halves share the port. Everything the app talks to is under `/api`;
 * everything else is the reader — `/` and `/{id}` serve the app's own
 * read-only build out of `../public`, which is what makes a published plan a
 * page anyone can open. See ../README.md.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

  /**
   * A page as a reader gets it: no publisher, no source path, nothing about
   * where the plan lives — only the plan.
   *
   * A workspace document keeps no copy here. Its page reads the room, so the
   * page follows the document as it is argued over rather than as it was on
   * the day someone pressed Share.
   */
  const readPage = async (id) => {
    const p = await db.page(id);
    if (!p) throw httpError(404, "this plan is not shared");
    const live = p.source === "workspace";
    const w = live ? await db.workspace(p.workspaceId) : null;
    if (live && !w) throw httpError(404, "this plan is not shared");
    return {
      id: p.id,
      name: w ? w.name : p.name,
      source: p.source,
      /** A live page is worth asking again for; a file's page is not. */
      live,
      publishedAt: p.publishedAt,
      markdown: live ? await rooms.markdown(p.workspaceId) : p.markdown,
    };
  };

  /**
   * Who may republish or stop a share: whoever published it, and — for a
   * workspace document — anyone in the room, since the page is the room's
   * and not one member's.
   */
  const allowedToChange = async (page, login) => {
    if (page.publishedBy === login) return;
    if (page.workspaceId && (await db.isMember(page.workspaceId, login))) return;
    throw httpError(404, "this plan is not shared");
  };

  /**
   * The two halves, told apart by the first segment.
   *
   * `/api` is the app's; the root is the reader's. The one exception is the
   * handful of paths the app used to call at the root — a build already on
   * someone's machine still calls them, and answering costs one regex.
   */
  const LEGACY = /^\/(auth|me|workspaces|w|share\/doc)(\/|$)/;

  async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/health" || path === "/api/health")) {
      return json(res, 200, { ok: true });
    }
    if (path.startsWith("/api/")) return api(req, res, path.slice(4));
    if (LEGACY.test(path)) return api(req, res, path);
    if (req.method === "GET" && path === "/share") {
      // The shell the fragment is read by: no id, no token, nothing of the
      // document. It resolves the token and leaves for the plan's page.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(viewerPage());
      return;
    }
    if (req.method === "GET") return reader(res, path);
    throw httpError(404, "not found");
  }

  async function api(req, res, path) {
    const m = (re) => path.match(re);
    let seg;

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
    // --- published pages ---------------------------------------------------
    // A page is a plan someone published; its id is the whole of the secret,
    // so reading one takes no session and no token — only the URL. Publishing
    // and stopping do take a session. See plans/public-plan-pages.md.
    if ((seg = m(/^\/pages\/([\w-]+)$/)) && req.method === "GET") {
      return json(res, 200, await readPage(seg[1]));
    }
    if (req.method === "POST" && path === "/pages") {
      const login = await who(req);
      const b = await body(req);
      const name = String(b.name ?? "").trim().slice(0, 200) || "plan";
      const markdown = String(b.markdown ?? "");
      // Republishing: the same page, the same URL, what the file says now.
      if (b.id) {
        const p = await db.page(String(b.id));
        if (!p) throw httpError(404, "this plan is not shared");
        await allowedToChange(p, login);
        if (p.source === "workspace") return json(res, 200, p);
        return json(res, 200, await db.republishPage(p.id, markdown, name));
      }
      if (b.workspaceId) {
        const { w } = await mine(req, String(b.workspaceId));
        return json(res, 201, await db.publishWorkspacePage(w.id, w.name, login));
      }
      const repo = String(b.repo ?? "").trim().slice(0, 200);
      const filePath = String(b.path ?? "").trim().slice(0, 500);
      if (!repo || !filePath) throw httpError(400, "a page needs a workspace, or a repository and a path");
      return json(res, 201, await db.publishRepoPage(repo, filePath, markdown, name, login));
    }
    if ((seg = m(/^\/pages\/([\w-]+)$/)) && req.method === "DELETE") {
      const login = await who(req);
      const p = await db.page(seg[1]);
      // Already not a page: stopping a share twice is not an error, it is the
      // state the caller asked for.
      if (!p) return json(res, 200, { ok: true });
      await allowedToChange(p, login);
      await db.revokePage(p.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/share/resolve") {
      // The old link's token, traded for the page its document now has. The
      // token is the authority here, exactly as it was for /share/doc.
      const { token } = await body(req);
      const id = await db.workspaceForShareToken(String(token ?? ""));
      const w = id ? await db.workspace(id) : null;
      if (!w) throw httpError(404, "this link is not a link any more");
      const page = await db.publishWorkspacePage(w.id, w.name, w.createdBy);
      return json(res, 200, { id: page.id });
    }
    if ((seg = m(/^\/workspaces\/([\w-]+)\/page$/)) && req.method === "GET") {
      // Whether this document is shared, for the member looking at it — not a
      // listing of anyone's pages, just the state of this one.
      const { w } = await mine(req, seg[1]);
      return json(res, 200, await db.workspacePage(w.id));
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
      // `/ws/{id}` without the prefix is what builds made before the reader
      // shipped ask for; both reach the same room.
      const seg = url.pathname.match(/^(?:\/api)?\/ws\/([\w-]+)$/);
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
 * The redirect the old share links land on, read once and held: it reads the
 * token out of the fragment, trades it for the document's page, and leaves.
 */
let viewerHtml = null;
function viewerPage() {
  if (viewerHtml === null) viewerHtml = readFileSync(new URL("./share.html", import.meta.url), "utf8");
  return viewerHtml;
}

/**
 * The reader: the app's own read-only build, in `../public`.
 *
 * `/` and `/{id}` are the same document — the page reads the id out of its own
 * address — so this is a static server with one rule on top of it. It is not
 * in the repository: `vite build --mode share` puts it there, and the image
 * builds it (see ../Dockerfile). Without it the server still answers the API,
 * and says plainly that the reader is missing rather than 404ing as if the
 * plan were not shared.
 */
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const ID_PATH = /^\/[A-Za-z0-9_-]{1,64}$/;
const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  map: "application/json",
};

async function reader(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    throw httpError(404, "not found");
  }
  if (rel) {
    const file = resolve(PUBLIC, rel);
    // `resolve` has already flattened any `..`; what is left of PUBLIC after
    // it is what decides whether this is ours to serve.
    if (file.startsWith(PUBLIC) && (await isFile(file))) {
      const ext = file.split(".").pop().toLowerCase();
      res.writeHead(200, {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        // Vite's assets are content-hashed; the shell below never is.
        "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
      });
      res.end(await readFile(file));
      return;
    }
  }
  if (pathname !== "/" && !ID_PATH.test(pathname)) throw httpError(404, "not found");
  const shell = resolve(PUBLIC, "index.html");
  if (!(await isFile(shell))) {
    throw httpError(503, "the reader is not built into this deployment");
  }
  res.writeHead(200, { "Content-Type": TYPES.html, "Cache-Control": "no-store" });
  res.end(await readFile(shell));
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
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
