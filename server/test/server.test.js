/**
 * The server's promises, exercised over real HTTP and a real websocket.
 *
 * Sign-in is the dev path: GitHub is not in the loop for a test, and the
 * device flow is two proxied calls the auth module owns. What is tested is
 * everything downstream of "the server knows who you are".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { startServer } from "../src/index.js";
import { MSG_SYNC, MSG_REVIEW } from "../src/rooms.js";

let s;
let base;
before(async () => {
  s = startServer({ port: 0, devLogin: true });
  await s.ready;
  base = `http://127.0.0.1:${s.port}`;
});
after(() => s.close());

async function call(path, { token, method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {
    // markdown comes back as text
  }
  return { status: res.status, value };
}

async function signIn(login) {
  const r = await call("/auth/dev", { method: "POST", body: { login } });
  assert.equal(r.status, 200);
  return r.value.token;
}

/** A client that speaks just enough of the protocol to sync one doc. */
function connect(id, token) {
  const doc = new Y.Doc();
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/${id}?token=${token}`);
  ws.binaryType = "arraybuffer";
  const reviews = [];
  let synced;
  const isSynced = new Promise((r) => (synced = r));
  ws.on("message", (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(dec, enc, doc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (kind === syncProtocol.messageYjsSyncStep2) synced();
    } else if (type === MSG_REVIEW) {
      reviews.push(JSON.parse(decoding.readVarString(dec)));
    }
  });
  doc.on("update", (update, origin) => {
    if (origin === ws) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  const open = new Promise((resolve, reject) => {
    ws.once("open", () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      ws.send(encoding.toUint8Array(enc));
      resolve();
    });
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { doc, ws, reviews, open, synced: isSynced, close: () => ws.close() };
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

test("a stranger sees nothing", async () => {
  assert.equal((await call("/workspaces")).status, 401);
  assert.equal((await call("/me", { token: "nope" })).status, 401);
});

test("a workspace belongs to whoever made it, and to whom they invite", async () => {
  const alice = await signIn("alice");
  const bob = await signIn("bob");
  const made = await call("/workspaces", { method: "POST", token: alice, body: { name: "Roadmap" } });
  assert.equal(made.status, 201);
  const id = made.value.id;
  assert.deepEqual(made.value.members, ["alice"]);

  // Bob is not in it, and the server does not admit that it exists.
  assert.equal((await call(`/workspaces/${id}`, { token: bob })).status, 404);
  assert.equal((await call("/workspaces", { token: bob })).value.length, 0);

  const invited = await call(`/workspaces/${id}/members`, {
    method: "POST",
    token: alice,
    body: { login: "bob" },
  });
  assert.deepEqual(invited.value.members, ["alice", "bob"]);
  assert.equal((await call("/workspaces", { token: bob })).value[0].id, id);
});

test("two people edit one document, and it survives the room emptying", async () => {
  const alice = await signIn("alice");
  const bob = await signIn("bob");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Doc" } })).value;
  await call(`/workspaces/${id}/members`, { method: "POST", token: alice, body: { login: "bob" } });

  const a = connect(id, alice);
  const b = connect(id, bob);
  await Promise.all([a.open, b.open, a.synced, b.synced]);
  a.doc.getText("t").insert(0, "hello");
  await until(() => b.doc.getText("t").toString() === "hello");
  b.doc.getText("t").insert(5, " world");
  await until(() => a.doc.getText("t").toString() === "hello world");
  a.doc.getMap("meta").set("markdown", "# Doc\n\nhello world\n");
  await until(() => b.doc.getMap("meta").get("markdown") === "# Doc\n\nhello world\n");

  a.close();
  b.close();
  await until(() => !s.rooms.rooms.has(id));

  // A newcomer gets the document from the database, not from memory.
  const c = connect(id, bob);
  await Promise.all([c.open, c.synced]);
  await until(() => c.doc.getText("t").toString() === "hello world");
  c.close();
});

test("the websocket refuses non-members before it opens", async () => {
  const alice = await signIn("alice");
  const eve = await signIn("eve");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Secret" } })).value;
  await assert.rejects(connect(id, eve).open, /401/);
  await assert.rejects(connect(id, "garbage").open, /401/);
});

test("the author cannot approve their own plan", async () => {
  const alice = await signIn("alice");
  const bob = await signIn("bob");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Rev" } })).value;
  await call(`/workspaces/${id}/members`, { method: "POST", token: alice, body: { login: "bob" } });

  const watching = connect(id, bob);
  await Promise.all([watching.open, watching.synced]);

  // Nothing to approve yet.
  assert.equal(
    (await call(`/workspaces/${id}/review`, { method: "POST", token: bob, body: { action: "approve" } })).status,
    409,
  );
  const asked = await call(`/workspaces/${id}/review`, { method: "POST", token: alice, body: { action: "request" } });
  assert.equal(asked.value.state, "requested");
  assert.equal(asked.value.requestedBy, "alice");

  const own = await call(`/workspaces/${id}/review`, { method: "POST", token: alice, body: { action: "approve" } });
  assert.equal(own.status, 403);

  const ok = await call(`/workspaces/${id}/review`, { method: "POST", token: bob, body: { action: "approve" } });
  assert.equal(ok.value.state, "approved");
  assert.equal(ok.value.decidedBy, "bob");

  // Everyone in the room heard about it.
  await until(() => watching.reviews.some((r) => r.state === "approved"));
  watching.close();
});

test("plan.md answers to a member or the workspace's own token, and nobody else", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Read" } })).value;
  const a = connect(id, alice);
  await Promise.all([a.open, a.synced]);
  a.doc.getMap("meta").set("markdown", "---\nstatus: ready\n---\n\n# Read\n");
  await until(() => s.rooms.rooms.get(id)?.doc.getMap("meta").get("markdown")?.includes("# Read"));

  const asMember = await call(`/w/${id}/plan.md`, { token: alice });
  assert.equal(asMember.status, 200);
  assert.equal(asMember.value, "---\nstatus: ready\n---\n\n# Read\n");

  const minted = await call(`/workspaces/${id}/token`, { method: "POST", token: alice });
  assert.equal(minted.status, 201);
  const viaToken = await call(`/w/${id}/plan.md`, { token: minted.value.token });
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.value, asMember.value);

  assert.equal((await call(`/w/${id}/plan.md`)).status, 404);
  const eve = await signIn("eve");
  assert.equal((await call(`/w/${id}/plan.md`, { token: eve })).status, 404);
  a.close();
});

test("the device flow proxies GitHub and mints a session of ours", async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push(url);
    const j = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (url.endsWith("/login/device/code")) {
      return j({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 });
    }
    if (url.endsWith("/login/oauth/access_token")) {
      return calls.filter((u) => u.endsWith("access_token")).length === 1
        ? j({ error: "authorization_pending" })
        : j({ access_token: "gh" });
    }
    if (url.endsWith("/user")) {
      assert.equal(init.headers.Authorization, "Bearer gh");
      return j({ login: "carol", name: "Carol", avatar_url: "https://a/c.png" });
    }
    throw new Error(`unexpected ${url}`);
  };
  const t = startServer({ port: 0, clientId: "cid", fetchImpl: fake });
  await t.ready;
  const b = `http://127.0.0.1:${t.port}`;
  try {
    const start = await (await fetch(`${b}/auth/device`, { method: "POST" })).json();
    assert.equal(start.userCode, "ABCD-1234");
    const poll = async () =>
      (await fetch(`${b}/auth/device/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode: start.deviceCode }) })).json();
    assert.deepEqual(await poll(), { pending: true, slowDown: false });
    const done = await poll();
    assert.equal(done.user.login, "carol");
    const me = await (await fetch(`${b}/me`, { headers: { Authorization: `Bearer ${done.token}` } })).json();
    assert.equal(me.name, "Carol");
  } finally {
    await t.close();
  }
});

test("a bad frame closes that client and nobody else", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Frames" } })).value;
  const good = connect(id, alice);
  await Promise.all([good.open, good.synced]);
  const bad = new WebSocket(`ws://127.0.0.1:${s.port}/ws/${id}?token=${alice}`);
  await new Promise((r) => bad.once("open", r));
  const closed = new Promise((r) => bad.once("close", (code) => r(code)));
  bad.send(new Uint8Array(0));
  assert.equal(await closed, 1003);
  // The room and the server are still there for the well-behaved one.
  good.doc.getText("t").insert(0, "still here");
  await until(() => s.rooms.rooms.get(id)?.doc.getText("t").toString() === "still here");
  assert.equal((await call("/health")).status, 200);
  good.close();
});

test("edits made just before the last client leaves survive an immediate reconnect", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Race" } })).value;
  const a = connect(id, alice);
  await Promise.all([a.open, a.synced]);
  a.doc.getText("t").insert(0, "first");
  await until(() => s.rooms.rooms.get(id)?.doc.getText("t").toString() === "first");
  a.close();
  // Straight back in, before the save could possibly have landed.
  const b = connect(id, alice);
  await Promise.all([b.open, b.synced]);
  await until(() => b.doc.getText("t").toString() === "first");
  b.doc.getText("t").insert(5, " second");
  await until(() => s.rooms.rooms.get(id)?.doc.getText("t").toString() === "first second");
  b.close();
  await until(() => !s.rooms.rooms.has(id));
  const c = connect(id, alice);
  await Promise.all([c.open, c.synced]);
  await until(() => c.doc.getText("t").toString() === "first second");
  c.close();
});
