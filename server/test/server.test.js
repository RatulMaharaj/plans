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
import { MSG_SYNC } from "../src/rooms.js";

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
function connect(id, token, workspace = null) {
  const doc = new Y.Doc();
  const at = workspace ? `&workspace=${workspace}` : "";
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/${id}?token=${token}${at}`);
  ws.binaryType = "arraybuffer";
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
  return { doc, ws, open, synced: isSynced, close: () => ws.close() };
}

/** The document id of one file in a workspace's tree. */
async function fileIn(workspaceId, token, path = "plan.md") {
  const tree = await call(`/workspaces/${workspaceId}/tree`, { token });
  const entry = tree.value.find((e) => e.path === path);
  assert.ok(entry, `${path} is in the tree`);
  return entry.doc;
}

/** Open a workspace's first file, ready to be typed into. */
async function openPlan(workspaceId, token) {
  const docId = await fileIn(workspaceId, token);
  const c = connect(docId, token, workspaceId);
  await Promise.all([c.open, c.synced]);
  return { ...c, docId };
}

/** Type markdown into an open file and wait for the server to hold it. */
async function publish(open, markdown) {
  open.doc.getMap("meta").set("markdown", markdown);
  await until(() => s.rooms.rooms.get(open.docId)?.doc.getMap("meta").get("markdown") === markdown);
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

test("an invite is an email, kept lowercase", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Mail" } })).value;
  const r = await call(`/workspaces/${id}/members`, { method: "POST", token: alice, body: { login: "Dana@Example.com" } });
  assert.deepEqual(r.value.members, ["alice", "dana@example.com"]);
  assert.equal((await call(`/workspaces/${id}/members`, { method: "POST", token: alice, body: { login: "not an email" } })).status, 400);
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

test("two people edit one file, and it survives the room emptying", async () => {
  const alice = await signIn("alice");
  const bob = await signIn("bob");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Doc" } })).value;
  await call(`/workspaces/${id}/members`, { method: "POST", token: alice, body: { login: "bob" } });

  const doc = await fileIn(id, alice);
  const a = connect(doc, alice, id);
  const b = connect(doc, bob, id);
  await Promise.all([a.open, b.open, a.synced, b.synced]);
  a.doc.getText("t").insert(0, "hello");
  await until(() => b.doc.getText("t").toString() === "hello");
  b.doc.getText("t").insert(5, " world");
  await until(() => a.doc.getText("t").toString() === "hello world");
  a.doc.getMap("meta").set("markdown", "# Doc\n\nhello world\n");
  await until(() => b.doc.getMap("meta").get("markdown") === "# Doc\n\nhello world\n");

  a.close();
  b.close();
  await until(() => !s.rooms.rooms.has(doc));

  // A newcomer gets the document from the database, not from memory.
  const c = connect(doc, bob, id);
  await Promise.all([c.open, c.synced]);
  await until(() => c.doc.getText("t").toString() === "hello world");
  c.close();
});

test("a workspace is a folder: the tree is a room, and so is every file in it", async () => {
  const alice = await signIn("alice");
  const bob = await signIn("bob");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Folder" } })).value;
  await call(`/workspaces/${id}/members`, { method: "POST", token: alice, body: { login: "bob" } });

  // Made a folder from the moment it exists, with one file in it.
  const first = (await call(`/workspaces/${id}/tree`, { token: alice })).value;
  assert.deepEqual(
    first.map((e) => [e.path, e.kind]),
    [["plan.md", "file"]],
  );

  // The tree is the room whose id is the workspace's; a file created in it is
  // a room of its own the moment the tree names it, with nothing saved yet.
  const treeA = connect(id, alice);
  const treeB = connect(id, bob);
  await Promise.all([treeA.open, treeB.open, treeA.synced, treeB.synced]);
  const made = "notes/idea.md";
  treeA.doc.getMap("tree").set("notes", { kind: "folder" });
  treeA.doc.getMap("tree").set(made, { kind: "file", doc: "brand-new-doc-id" });
  await until(() => treeB.doc.getMap("tree").get(made));

  const fresh = connect("brand-new-doc-id", bob, id);
  await Promise.all([fresh.open, fresh.synced]);
  fresh.doc.getMap("meta").set("markdown", "# Idea\n");
  await until(() => s.rooms.rooms.get("brand-new-doc-id")?.doc.getMap("meta").get("markdown"));
  assert.equal((await call(`/w/${id}/${made}`, { token: alice })).value, "# Idea\n");

  // A rename is a move of the key; the file's document id does not change.
  const entry = treeA.doc.getMap("tree").get(made);
  treeA.doc.getMap("tree").delete(made);
  treeA.doc.getMap("tree").set("notes/plan.md", entry);
  await until(() => treeB.doc.getMap("tree").get("notes/plan.md"));
  assert.equal((await call(`/w/${id}/notes/plan.md`, { token: alice })).value, "# Idea\n");
  assert.equal((await call(`/w/${id}/${made}`, { token: alice })).status, 404);

  // The listing is the folder, kinds and all.
  const listed = await call(`/w/${id}/`, { token: alice });
  assert.deepEqual(listed.value.name, "Folder");
  assert.deepEqual(
    listed.value.files.map((e) => e.path).sort(),
    ["notes", "notes/plan.md", "plan.md"],
  );

  fresh.close();
  treeA.close();
  treeB.close();
});

test("the websocket refuses non-members before it opens", async () => {
  const alice = await signIn("alice");
  const eve = await signIn("eve");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Secret" } })).value;
  const doc = await fileIn(id, alice);
  await assert.rejects(connect(id, eve).open, /401/);
  await assert.rejects(connect(id, "garbage").open, /401/);
  await assert.rejects(connect(doc, eve, id).open, /401/);
  // Naming a workspace does not get you into it — a member may open a document
  // of theirs that has nothing written to it yet, and a stranger may not.
  await assert.rejects(connect("not-a-document-yet", eve, id).open, /401/);
  // And an id nobody has claimed, named against no workspace, is not a room.
  await assert.rejects(connect("not-a-document-yet", alice).open, /401/);
});

test("plan.md answers to a member or the workspace's own token, and nobody else", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Read" } })).value;
  const a = await openPlan(id, alice);
  await publish(a, "---\nstatus: ready\n---\n\n# Read\n");

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

test("a share link is its own token: many, listed, and revocable one at a time", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Share" } })).value;
  const a = await openPlan(id, alice);
  await publish(a, "---\nstatus: ready\n---\n\n# Share\n");

  const one = await call(`/workspaces/${id}/share`, { method: "POST", token: alice });
  assert.equal(one.status, 201);
  const two = await call(`/workspaces/${id}/share`, { method: "POST", token: alice });

  // The token is the address: no workspace id anywhere in the request.
  const read = await call("/share/doc", { token: one.value.token });
  assert.equal(read.status, 200);
  assert.equal(read.value.name, "Share");
  // A link names a file, and the default is the one every link minted before
  // folders was already pointing at.
  assert.equal(read.value.path, "plan.md");
  assert.match(read.value.markdown, /# Share/);
  // The file and nothing else about the room: no member list, and no review
  // state, which the file's own `status:` has replaced.
  assert.equal(read.value.review, undefined);
  assert.equal(read.value.members, undefined);

  const listed = await call(`/workspaces/${id}/share`, { token: alice });
  assert.deepEqual(
    listed.value.map((l) => l.id).sort(),
    [one.value.id, two.value.id].sort(),
  );
  assert.ok(listed.value.every((l) => l.createdBy === "alice"));
  // Thirty days, stamped at mint.
  assert.ok(listed.value.every((l) => l.expiresAt - l.createdAt === 30 * 24 * 60 * 60 * 1000));

  // Killing one link breaks neither the other nor the factory's read token.
  const factory = await call(`/workspaces/${id}/token`, { method: "POST", token: alice });
  const revoked = await call(`/workspaces/${id}/share/revoke`, {
    method: "POST",
    token: alice,
    body: { id: one.value.id },
  });
  assert.equal(revoked.status, 200);
  assert.equal((await call("/share/doc", { token: one.value.token })).status, 404);
  assert.equal((await call("/share/doc", { token: two.value.token })).status, 200);
  assert.equal((await call(`/w/${id}/plan.md`, { token: factory.value.token })).status, 200);
  assert.deepEqual(
    (await call(`/workspaces/${id}/share`, { token: alice })).value.map((l) => l.id),
    [two.value.id],
  );
  // Revoking twice is not a second revocation.
  assert.equal(
    (await call(`/workspaces/${id}/share/revoke`, { method: "POST", token: alice, body: { id: one.value.id } })).status,
    404,
  );

  // A dead link and a link that never existed answer alike, and a stranger
  // can neither mint nor list.
  assert.equal((await call("/share/doc")).status, 404);
  assert.equal((await call("/share/doc", { token: "never-a-link" })).status, 404);
  const eve = await signIn("eve");
  assert.equal((await call(`/workspaces/${id}/share`, { method: "POST", token: eve })).status, 404);
  assert.equal((await call(`/workspaces/${id}/share`, { token: eve })).status, 404);
  assert.equal(
    (await call(`/workspaces/${id}/share/revoke`, { method: "POST", token: eve, body: { id: two.value.id } })).status,
    404,
  );
  a.close();
});

test("an expired link answers exactly like a revoked one", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Old" } })).value;
  const live = await call(`/workspaces/${id}/share`, { method: "POST", token: alice });
  assert.equal((await call("/share/doc", { token: live.value.token })).status, 200);

  // Thirty days is not something a test can wait for, so this one is minted
  // already expired — the route's own lifetime is the default, not a rule.
  const dead = await s.db.createShareToken(id, "alice", "plan.md", -1000);
  assert.equal((await call("/share/doc", { token: dead.token })).status, 404);
  // And it never appears in the list, which only ever shows live links.
  assert.deepEqual(
    (await call(`/workspaces/${id}/share`, { token: alice })).value.map((l) => l.id),
    [live.value.id],
  );
});

test("a share link names a file, and copying out kills every link into the room", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Folder" } })).value;
  const tree = connect(id, alice);
  await Promise.all([tree.open, tree.synced]);
  tree.doc.getMap("tree").set("notes/second.md", { kind: "file", doc: "second-doc" });
  // The tree has to name the file before a socket into it can be authorised.
  await until(() => s.rooms.rooms.get(id)?.doc.getMap("tree").get("notes/second.md"));
  const second = connect("second-doc", alice, id);
  await Promise.all([second.open, second.synced]);
  second.doc.getMap("meta").set("markdown", "---\nstatus: draft\n---\n\n# Second\n");
  await until(() => s.rooms.rooms.get("second-doc")?.doc.getMap("meta").get("markdown"));

  const link = await call(`/workspaces/${id}/share`, {
    method: "POST",
    token: alice,
    body: { path: "notes/second.md" },
  });
  assert.equal(link.status, 201);
  assert.equal(link.value.path, "notes/second.md");
  const read = await call("/share/doc", { token: link.value.token });
  assert.equal(read.value.path, "notes/second.md");
  assert.match(read.value.markdown, /# Second/);

  // A link into a file that is not there is not a link.
  assert.equal(
    (await call(`/workspaces/${id}/share`, { method: "POST", token: alice, body: { path: "nope.md" } })).status,
    404,
  );

  // Copying the plan out takes the room's links with it — one call, and the
  // link into plan.md as well as the one into notes/second.md stop working.
  const plan = await call(`/workspaces/${id}/share`, { method: "POST", token: alice });
  const all = await call(`/workspaces/${id}/share/revoke`, { method: "POST", token: alice, body: { all: true } });
  assert.equal(all.value.revoked, 2);
  assert.equal((await call("/share/doc", { token: link.value.token })).status, 404);
  assert.equal((await call("/share/doc", { token: plan.value.token })).status, 404);
  assert.deepEqual((await call(`/workspaces/${id}/share`, { token: alice })).value, []);

  second.close();
  tree.close();
});

test("the share page is a shell: the fragment never reaches the server", async () => {
  const res = await fetch(`${base}/share`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /location\.hash/);
  // Nothing of any document, and no id to guess at: this is what an unfurler
  // fetching a share link gets.
  assert.doesNotMatch(html, /workspace_id/);
});

test("the device flow goes through Auth0 and mints a session of ours", async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const idToken = await new SignJWT({ email: "Carol@Example.com", name: "Carol", picture: "https://a/c.png" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://looped.eu.auth0.com/")
    .setAudience("cid")
    .setSubject("auth0|carol")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  const calls = [];
  const fake = async (url, init) => {
    calls.push(url);
    const j = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (url.endsWith("/oauth/device/code")) {
      assert.match(init.body, /client_id=cid/);
      assert.match(init.body, /scope=openid\+profile\+email/);
      return j({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://looped.eu.auth0.com/activate", verification_uri_complete: "https://looped.eu.auth0.com/activate?user_code=ABCD-1234", interval: 5, expires_in: 900 });
    }
    if (url.endsWith("/oauth/token")) {
      assert.match(init.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
      return calls.filter((u) => u.endsWith("/oauth/token")).length === 1
        ? j({ error: "slow_down" })
        : j({ access_token: "opaque", id_token: idToken, token_type: "Bearer" });
    }
    if (url.endsWith("/.well-known/jwks.json")) return j({ keys: [jwk] });
    throw new Error(`unexpected ${url}`);
  };
  const t = startServer({ port: 0, domain: "looped.eu.auth0.com", clientId: "cid", fetchImpl: fake });
  await t.ready;
  const b = `http://127.0.0.1:${t.port}`;
  try {
    const start = await (await fetch(`${b}/auth/device`, { method: "POST" })).json();
    assert.equal(start.userCode, "ABCD-1234");
    assert.equal(start.verificationUri, "https://looped.eu.auth0.com/activate?user_code=ABCD-1234");
    const poll = async () =>
      (await fetch(`${b}/auth/device/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode: start.deviceCode }) })).json();
    assert.deepEqual(await poll(), { pending: true, slowDown: true });
    const done = await poll();
    // The email is the login, lowercased; the tenant's spelling is not kept.
    assert.equal(done.user.login, "carol@example.com");
    assert.equal(done.user.name, "Carol");
    const me = await (await fetch(`${b}/me`, { headers: { Authorization: `Bearer ${done.token}` } })).json();
    assert.equal(me.login, "carol@example.com");
  } finally {
    await t.close();
  }
});

test("an identity the tenant did not sign is refused", async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const tenant = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(tenant.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const forged = await new SignJWT({ email: "eve@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://looped.eu.auth0.com/")
    .setAudience("cid")
    .setExpirationTime("1h")
    .sign(other.privateKey);
  const fake = async (url) => {
    const j = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (url.endsWith("/oauth/token")) return j({ id_token: forged });
    if (url.endsWith("/.well-known/jwks.json")) return j({ keys: [jwk] });
    throw new Error(`unexpected ${url}`);
  };
  const t = startServer({ port: 0, domain: "looped.eu.auth0.com", clientId: "cid", fetchImpl: fake });
  await t.ready;
  try {
    const r = await fetch(`http://127.0.0.1:${t.port}/auth/device/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode: "dc" }) });
    assert.equal(r.status, 401);
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
