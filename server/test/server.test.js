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

test("a share link is its own token: many, listed, and revocable one at a time", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/workspaces", { method: "POST", token: alice, body: { name: "Share" } })).value;
  const a = connect(id, alice);
  await Promise.all([a.open, a.synced]);
  a.doc.getMap("meta").set("markdown", "---\nstatus: ready\n---\n\n# Share\n");
  await until(() => s.rooms.rooms.get(id)?.doc.getMap("meta").get("markdown")?.includes("# Share"));

  const one = await call(`/workspaces/${id}/share`, { method: "POST", token: alice });
  assert.equal(one.status, 201);
  const two = await call(`/workspaces/${id}/share`, { method: "POST", token: alice });

  // The token is the address: no workspace id anywhere in the request.
  const read = await call("/share/doc", { token: one.value.token });
  assert.equal(read.status, 200);
  assert.equal(read.value.name, "Share");
  assert.match(read.value.markdown, /# Share/);
  // The chip's state, and nothing else about the argument: no trail of who
  // asked or decided, and no member list.
  assert.deepEqual(read.value.review, { state: "none" });
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
  const dead = await s.db.createShareToken(id, "alice", -1000);
  assert.equal((await call("/share/doc", { token: dead.token })).status, 404);
  // And it never appears in the list, which only ever shows live links.
  assert.deepEqual(
    (await call(`/workspaces/${id}/share`, { token: alice })).value.map((l) => l.id),
    [live.value.id],
  );
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

test("the app's API is under /api, and the old addresses still answer", async () => {
  const alice = await signIn("alice");
  const made = await call("/api/workspaces", { method: "POST", token: alice, body: { name: "Prefixed" } });
  assert.equal(made.status, 201);
  // The same workspace, asked for the old way: a build already on someone's
  // machine keeps working through the move.
  assert.equal((await call(`/workspaces/${made.value.id}`, { token: alice })).value.name, "Prefixed");
  assert.equal((await call("/api/me", { token: alice })).value.login, "alice");
  assert.equal((await call("/api/health")).value.ok, true);
});

test("a repository file published is a page, republished by its author, and stopped", async () => {
  const alice = await signIn("alice");
  const made = await call("/api/pages", {
    method: "POST",
    token: alice,
    body: { repo: "/repo/one", path: "plans/ship.md", name: "ship.md", markdown: "# Ship\n" },
  });
  assert.equal(made.status, 201);
  const { id } = made.value;
  // Long enough that the address is the whole of the security.
  assert.ok(id.length >= 32);

  // No session, no token, no membership: the URL is the credential.
  const read = await call(`/api/pages/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.value.name, "ship.md");
  assert.equal(read.value.markdown, "# Ship\n");
  assert.equal(read.value.source, "repository");
  assert.equal(read.value.live, false);
  // Nothing about where the plan came from, or who published it.
  assert.equal(read.value.repo, undefined);
  assert.equal(read.value.publishedBy, undefined);

  // A save republishes the same page: same address, newer plan.
  const again = await call("/api/pages", {
    method: "POST",
    token: alice,
    body: { id, name: "ship.md", markdown: "# Ship\n\nSoon.\n" },
  });
  assert.equal(again.status, 200);
  assert.equal(again.value.id, id);
  assert.match((await call(`/api/pages/${id}`)).value.markdown, /Soon\./);

  // Nobody else's to republish or to stop, and saying so as a 404 rather than
  // a 403 — which would confirm the id exists.
  const eve = await signIn("eve");
  assert.equal(
    (await call("/api/pages", { method: "POST", token: eve, body: { id, markdown: "mine now" } })).status,
    404,
  );
  assert.equal((await call(`/api/pages/${id}`, { method: "DELETE", token: eve })).status, 404);
  assert.match((await call(`/api/pages/${id}`)).value.markdown, /Soon\./);

  assert.equal((await call(`/api/pages/${id}`, { method: "DELETE", token: alice })).status, 200);
  assert.equal((await call(`/api/pages/${id}`)).status, 404);
  // Stopped twice is the state that was asked for, not an error — but the
  // address stays dead, since republishing it would raise the dead.
  assert.equal((await call(`/api/pages/${id}`, { method: "DELETE", token: alice })).status, 200);
  assert.equal(
    (await call("/api/pages", { method: "POST", token: alice, body: { id, markdown: "back" } })).status,
    404,
  );
});

test("a workspace document's page reads the room, and there is only ever one of it", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/api/workspaces", { method: "POST", token: alice, body: { name: "Live" } })).value;
  const a = connect(id, alice);
  await Promise.all([a.open, a.synced]);
  a.doc.getMap("meta").set("markdown", "# Live\n");
  await until(() => s.rooms.rooms.get(id)?.doc.getMap("meta").get("markdown")?.includes("# Live"));

  const made = await call("/api/pages", { method: "POST", token: alice, body: { workspaceId: id } });
  assert.equal(made.status, 201);
  const page = made.value.id;
  const read = await call(`/api/pages/${page}`);
  assert.equal(read.value.source, "workspace");
  assert.equal(read.value.live, true);
  assert.match(read.value.markdown, /# Live/);

  // The room moves on; the page is already there.
  a.doc.getMap("meta").set("markdown", "# Live\n\nAnd moving.\n");
  await until(() => s.rooms.rooms.get(id)?.doc.getMap("meta").get("markdown")?.includes("moving"));
  assert.match((await call(`/api/pages/${page}`)).value.markdown, /And moving\./);

  // Sharing twice hands back the page that exists, so the address a member
  // gave out stays the address.
  const twice = await call("/api/pages", { method: "POST", token: alice, body: { workspaceId: id } });
  assert.equal(twice.value.id, page);
  assert.equal((await call(`/api/workspaces/${id}/page`, { token: alice })).value.id, page);

  // A member who did not publish it can still stop it: the page is the
  // room's, not one member's. A stranger cannot even see that it is shared.
  const eve = await signIn("eve");
  assert.equal((await call(`/api/workspaces/${id}/page`, { token: eve })).status, 404);
  await call(`/api/workspaces/${id}/members`, { method: "POST", token: alice, body: { login: "eve@x.com" } });
  const bob = await signIn("eve@x.com");
  assert.equal((await call(`/api/pages/${page}`, { method: "DELETE", token: bob })).status, 200);
  assert.equal((await call(`/api/pages/${page}`)).status, 404);
  a.close();
});

test("an old share link resolves to the document's page", async () => {
  const alice = await signIn("alice");
  const { id } = (await call("/api/workspaces", { method: "POST", token: alice, body: { name: "Old link" } })).value;
  const minted = await call(`/api/workspaces/${id}/share`, { method: "POST", token: alice });
  const resolved = await call("/api/share/resolve", { method: "POST", body: { token: minted.value.token } });
  assert.equal(resolved.status, 200);
  // Resolving publishes if nobody had — the link was a promise to a reader,
  // and it is kept whether or not anyone has pressed Share since.
  assert.equal((await call(`/api/workspaces/${id}/page`, { token: alice })).value.id, resolved.value.id);
  // The same link twice lands in the same place.
  assert.equal(
    (await call("/api/share/resolve", { method: "POST", body: { token: minted.value.token } })).value.id,
    resolved.value.id,
  );

  await call(`/api/workspaces/${id}/share/revoke`, { method: "POST", token: alice, body: { id: minted.value.id } });
  assert.equal(
    (await call("/api/share/resolve", { method: "POST", body: { token: minted.value.token } })).status,
    404,
  );
  assert.equal((await call("/api/share/resolve", { method: "POST", body: { token: "never" } })).status, 404);
});

test("the reader's addresses are the reader's, whether or not it is built", async () => {
  // `/` and `/{id}` are one document — the page reads the id out of its own
  // address. Nothing is built in a test, so what is asserted is that the
  // server claims those addresses and says plainly why it cannot serve them,
  // rather than 404ing as if the plan were not shared.
  for (const path of ["/", "/aaaaaaaaaaaaaaaaaaaaaaaa"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /reader/);
  }
  // Not an id and not a file: that really is a 404.
  assert.equal((await fetch(`${base}/not/a/page`)).status, 404);
  // And nothing above the reader's folder is servable.
  assert.equal((await fetch(`${base}/../src/db.js`)).status, 404);
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
