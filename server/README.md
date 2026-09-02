# The workspace server

A workspace is a folder of markdown files several people edit at once, with
cursors and presence, hosted rather than backed by a repository. Files and
folders are created, renamed, moved and deleted as on disk, and every change
lands for everyone as it happens. When an argument settles, the plan leaves the
folder — copied into a local repository from the app — and everything
downstream works exactly as it does for any other file. The workspace is
upstream of the file world, not a replacement for it. The reasoning is in
[`plans/hosted-workspaces.md`](../plans/hosted-workspaces.md) and
[`plans/workspace-folders/`](../plans/workspace-folders).

This is the folder. One Node process, one Postgres database, one websocket per
open document. Nothing here is a queue, a second database, or a framework, and
the moment it wants one the scope has slipped.

## Rooms, trees and files

A room is one Yjs document, and a workspace is made of several:

- **The tree** is the room whose id *is* the workspace's id. It holds a map of
  path → `{ kind: "file" | "folder", doc: <id> }`, so create, rename, move and
  delete are transactions on a map everyone is looking at, and two people
  acting at once merge rather than fight. A rename is a move of the key: the
  document id does not change, so anyone with the file open carries on editing
  the same document under its new name.
- **Each file** is a room of its own, keyed by the document id the tree gives
  it. Its `meta.markdown` is whatever the last editing client serialised, which
  is what the read endpoint and the share viewer answer with — the server needs
  no editor schema to serve a file.

Which workspace a document belongs to is what authorises the socket, and it
comes from the `docs` table. A file made a moment ago has no row there — its
id is minted by whoever created it, because a round trip in the middle of a
tree transaction would be a file that exists for one person before it exists
for anyone — so the socket carries `?workspace=<id>` and membership of that
workspace is what lets it in. A document that *does* have a row is judged by
that row, so naming your own workspace cannot reach anyone else's document.

Every workspace has a `plan.md`. A new one is created with it; a workspace
made before folders keeps its one document under that name, so the read
endpoint and every share link minted back then carry on answering.

## Running it

```sh
node server/src/index.js
```

| Variable               | Default          | What it is                                                                          |
| ---------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `PORT`                 | `8787`           |                                                                                     |
| `HOST`                 | `127.0.0.1`      | `0.0.0.0` in the container, behind whatever terminates TLS.                          |
| `DATABASE_URL`         | —                | Postgres. Unset, the server runs an in-process Postgres (PGlite): a laptop, a test.   |
| `AUTH0_DOMAIN`         | —                | The looped Auth0 tenant, e.g. `looped.eu.auth0.com`. Without it, sign-in is off.     |
| `AUTH0_CLIENT_ID`      | —                | The tenant's *native* application for Plans, with the Device Code grant enabled.     |
| `WORKSPACES_DEV_LOGIN` | —                | `1` enables `POST /auth/dev`, a session for a bare login. Tests and laptops only.     |

The app learns where this server is at build time, from `VITE_WORKSPACE_URL`
(the release workflow reads it from the repository variable `WORKSPACE_URL`).
A build made without it shows no workspaces at all. On a laptop, point a dev
build at a local server with `VITE_WORKSPACE_URL=http://localhost:8787 pnpm dev`.

Node 22 or newer. The database driver is `pg`. The tables are drizzle's:
`src/schema.js` is their shape, `drizzle/` holds the SQL that drizzle-kit
generated from it, and the server applies that folder on start — under an
advisory lock, so two replicas starting together take turns — before it
listens. The ledger is `drizzle.plans_migrations`, the looped apps' shape.
An empty database is a valid one.

To change a table: edit `src/schema.js`, run
`pnpm --filter plans-workspaces db:generate`, and commit the new file under
`drizzle/`. Never edit a generated file, and never edit the schema without
generating: the ledger records what has been applied, and a hand-made change
is one it does not know about.

### The database

Its own database on the looped Postgres server, not a schema in `looped`:
nothing here joins anything of looped's, and a workspace document is a blob
the other apps have no reason to see.

```sql
CREATE DATABASE plans OWNER <the role the other looped apps connect as>;
```

Then `DATABASE_URL` is the looped connection string with `/plans` as the
database. The tables are created on first start.

### Secrets: Infisical

The server's secrets live in the looped Infisical project, under
`/apps/plans` (with `/shared` merged after it, as the other apps
do). `server/.infisical.json` names the project, so on a laptop:

```sh
pnpm --filter plans-workspaces dev      # infisical run … -- node src/index.js
```

What goes in the folder, per environment:

| Secret             | dev                          | prod                         |
| ------------------ | ---------------------------- | ---------------------------- |
| `DATABASE_URL`     | leave unset for PGlite, or a local Postgres | the `plans` database above |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` | the tenant and its native application for Plans | the same, or shared from `/shared` |

### The container

```sh
docker build -f server/Dockerfile -t plans-workspaces .
docker run --rm -p 8787:8787 plans-workspaces          # in-process database, no sign-in
```

`.github/workflows/server-image.yml` publishes
`ghcr.io/loopedautomation/plans-workspaces` on every push to `main` that touches
the server (`:main`, `:sha-…`) and on `server-vX.Y.Z` tags. Point a Coolify
application at that image and give it the same environment the looped
services get:

| Variable                                        | Value                                                |
| ----------------------------------------------- | ---------------------------------------------------- |
| `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` | a machine identity with read on `/apps/plans` and `/shared` |
| `INFISICAL_PROJECT_ID`                          | `85f068d3-bcfe-4e1e-90e0-97845cf7058c`               |
| `INFISICAL_API_URL`                             | `https://infisical.looped.sh`                        |
| `INFISICAL_ENV`                                 | `prod` (the default)                                 |

The entrypoint exchanges the identity for a token and wraps the process in
`infisical run`; with no Infisical variables it starts unchanged, which is
what `docker run` above does.

**Sign-in is Auth0's device flow**, against the tenant the other looped apps
use, so a workspace member is the identity they already have. It needs a
*Native* application in the tenant with the *Device Code* grant enabled and
`openid profile email` in its allowed scopes; no callback URL, because the
desktop app has nowhere to be sent back to. The app shows a code, the
person confirms it in a browser, and this server does the polling. What the
tenant hands back is an ID token; the server verifies it against the
tenant's signing keys, reads the email, and mints a session of its own. The
client id is not a secret, but it lives here rather than in the app so that
changing it does not mean shipping a build.

People are known by email, lowercased: it is what an invite names before
its subject has ever signed in.

## What it holds

Users by email; sessions, as hashed tokens; workspaces and their members (by
email, so an invite can precede the invitee's first sign-in); the read token
and any share links, hashed, each link naming a file; and every document as a
Yjs update blob in `docs`, keyed by its own id and carrying the workspace it
belongs to and whether it is that workspace's tree or one of its files.

There is no review state. A workspace used to hold one — requested, approved,
changes, with the rule that the author could not approve their own plan — and
it has been retired: `status:` in a file's frontmatter and `approved` as a
human's word say what the gate said, and they travel with the file into the
repository instead of staying behind on a server. `0001_workspace_folders.sql`
is where both go: the review columns are dropped, and the old
one-document-per-workspace shape of `docs` becomes one row per document, each
old row keeping its bytes and gaining an id of its own.

## The API

Every call is JSON, and every call that needs a person carries
`Authorization: Bearer <session>`.

| Route                                | What it does                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `POST /auth/device`                  | Start Auth0's device flow: a code, and the page that confirms it.                           |
| `POST /auth/device/poll`             | `{ deviceCode }` → `{ pending: true }` until they have, then `{ token, user }`.               |
| `POST /auth/signout`                 | End the session.                                                                             |
| `GET /me`                            | Who the token belongs to.                                                                    |
| `GET /workspaces`                    | The workspaces you belong to.                                                                |
| `POST /workspaces`                   | `{ name }` → a new workspace with you in it.                                                 |
| `GET /workspaces/:id`                | One workspace: its name and members.                                                          |
| `POST /workspaces/:id/members`       | `{ login }` → invite by email.                                                                |
| `GET /workspaces/:id/tree`           | The tree, for a cold open: `[{ path, kind, doc, status }]`.                                   |
| `POST /workspaces/:id/token`         | Mint a read token for this workspace, for the factory's secrets.                             |
| `GET /w/:id/`                        | The folder: `{ name, files: [{ path, kind }] }`.                                              |
| `GET /w/:id/<path>`                  | One file as markdown — for a member's session or the workspace's read token.                  |
| `POST /workspaces/:id/share`         | `{ path }` → a link to that file: `{ id, token, path, createdBy, createdAt, expiresAt }`.      |
| `GET /workspaces/:id/share`          | The live links, newest first, for the revoke list.                                            |
| `POST /workspaces/:id/share/revoke`  | `{ id }` → that one link stops working; `{ all: true }` → every link into this workspace does. |
| `GET /share/doc`                     | The shared file, for a share token: `{ name, path, markdown }`.                                |
| `GET /share`                         | The viewer page: a static shell that reads the token from `location.hash`.                    |
| `WS /ws/:id?token=<session>&workspace=<id>` | One live document — a tree or a file: y-websocket's sync and awareness messages.       |

A workspace you are not a member of answers `404`, never `403`: a stranger
learns nothing, not even that the id exists. A share token that was revoked,
that has expired, or that was never minted here answers the same way.

### Share links

A share link names one file: `POST /workspaces/:id/share` takes the path, and
the viewer shows that file. The token is still the workspace's, so one
revocation kills one link and `{ all: true }` kills every link into the
workspace — which is what copying a plan out into a repository does, because
the document the links point at is a file with a repository's own rules now.

A share link is `https://<server>/share#<token>`. Browsers never send the
fragment, so the access log, any proxy and any unfurler see `/share` and get a
static shell with nothing in it; the viewer's script reads `location.hash` and
fetches `/share/doc` with `Authorization: Bearer`, which is the discipline the
rest of the API already speaks. The token is the address — the workspace id is
never in the URL.

Share tokens are their own table rather than a flag on `read_tokens`, because
the two have different lives: the factory's read token is minted once and lives
in secrets, share links are minted casually and revoked on a whim, and the list
one UI shows should never have the other in it. Both are stored hashed;
revoking is a timestamp, not a delete. A share link also expires thirty days
after minting — revocation answers the leaked link, expiry answers the
forgotten one — and an expired link is indistinguishable from a revoked one
from outside. The reasoning is in
[`plans/sharable-links.md`](../plans/sharable-links.md).

`server/src/share.html` is the whole viewer: one self-contained file, no build
step and no framework, with the file rendered at reading width, raw HTML
escaped, frontmatter shown as a status chip, mermaid fences drawn as diagrams
(one module import from a CDN; failing leaves the diagram's own source on the
page), and a print stylesheet — ⌘P is the export button.

## Tests

```sh
pnpm --filter plans-workspaces test
```

Real HTTP and a real websocket against an in-process Postgres, so the suite
needs nothing installed. The tenant is stubbed only in the tests that are
about the device flow, with a real RS256 key so verification is exercised.
