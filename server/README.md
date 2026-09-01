# The workspace server

A workspace is a room where a plan gets argued: a hosted markdown document
several people edit at once, with cursors and presence, and a review gate at
the end. When the argument settles, the plan leaves the room — copied into a
local repository from the app — and everything downstream works exactly as it
does for any other file. The workspace is upstream of the file world, not a
replacement for it. The reasoning is in
[`plans/hosted-workspaces.md`](../plans/hosted-workspaces.md).

This is the room. One Node process, one SQLite file, one websocket per open
document. Nothing here is a queue, a second database, or a framework, and the
moment it wants one the scope has slipped.

## Running it

```sh
node server/src/index.js
```

| Variable               | Default          | What it is                                                                          |
| ---------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `PORT`                 | `8787`           |                                                                                     |
| `HOST`                 | `127.0.0.1`      | `0.0.0.0` in the container, behind whatever terminates TLS.                          |
| `DATABASE_URL`         | —                | Postgres. Unset, the server runs an in-process Postgres (PGlite): a laptop, a test.   |
| `GITHUB_CLIENT_ID`     | —                | The GitHub OAuth app that sign-in goes through. Without it, sign-in is off.           |
| `WORKSPACES_DEV_LOGIN` | —                | `1` enables `POST /auth/dev`, a session for a bare login. Tests and laptops only.     |

Node 22 or newer. The database driver is `pg`; the schema is created on
start, with `IF NOT EXISTS` everywhere, so an empty database is a valid one.

### The database

Its own database on the looped Postgres server, not a schema in `looped`:
nothing here joins anything of looped's, and a workspace document is a blob
the other apps have no reason to see.

```sql
CREATE DATABASE plans_workspaces;
CREATE USER plans_workspaces WITH PASSWORD '…';
GRANT ALL PRIVILEGES ON DATABASE plans_workspaces TO plans_workspaces;
```

Then `DATABASE_URL=postgres://plans_workspaces:…@<looped db host>:5432/plans_workspaces`.

### Secrets: Infisical

The server's secrets live in the looped Infisical project, under
`/apps/plans-workspaces` (with `/shared` merged after it, as the other apps
do). `server/.infisical.json` names the project, so on a laptop:

```sh
pnpm --filter plans-workspaces dev      # infisical run … -- node src/index.js
```

What goes in the folder, per environment:

| Secret             | dev                          | prod                         |
| ------------------ | ---------------------------- | ---------------------------- |
| `DATABASE_URL`     | leave unset for PGlite, or a local Postgres | the `plans_workspaces` database above |
| `GITHUB_CLIENT_ID` | a dev OAuth app              | the real one                 |

### The container

```sh
docker build -f server/Dockerfile -t plans-workspaces .
docker run --rm -p 8787:8787 plans-workspaces          # in-process database, no sign-in
```

`.github/workflows/server-image.yml` publishes
`ghcr.io/ratulmaharaj/plans-workspaces` on every push to `main` that touches
the server (`:main`, `:sha-…`) and on `server-vX.Y.Z` tags. Point a Coolify
application at that image and give it the same environment the looped
services get:

| Variable                                        | Value                                                |
| ----------------------------------------------- | ---------------------------------------------------- |
| `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` | a machine identity with read on `/apps/plans-workspaces` and `/shared` |
| `INFISICAL_PROJECT_ID`                          | `85f068d3-bcfe-4e1e-90e0-97845cf7058c`               |
| `INFISICAL_API_URL`                             | `https://infisical.looped.sh`                        |
| `INFISICAL_ENV`                                 | `prod` (the default)                                 |

The entrypoint exchanges the identity for a token and wraps the process in
`infisical run`; with no Infisical variables it starts unchanged, which is
what `docker run` above does.

**The GitHub OAuth app** is an ordinary one from *Settings → Developer
settings → OAuth Apps*, with *Device flow* enabled. No callback URL matters,
because the desktop app has nowhere for GitHub to send anyone back to; the
app shows a code, the person types it at github.com, and this server does the
polling. The client id is not a secret, but it lives here rather than in the
app so that changing it does not mean shipping a build.

## What it holds

Users by GitHub login; sessions, as hashed tokens; workspaces, their members
(by login, so an invite can precede the invitee's first sign-in), the review
state; and each workspace's document as a Yjs update blob, in Postgres. The document's
markdown is whatever the last editing client serialised, kept in the same Yjs
doc under `meta.markdown`, so the read endpoint answers without needing an
editor's schema on the server.

## The API

Every call is JSON, and every call that needs a person carries
`Authorization: Bearer <session>`.

| Route                                | What it does                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `POST /auth/device`                  | Start GitHub's device flow: a code to type, and where to type it.                            |
| `POST /auth/device/poll`             | `{ deviceCode }` → `{ pending: true }` until they have, then `{ token, user }`.               |
| `POST /auth/signout`                 | End the session.                                                                             |
| `GET /me`                            | Who the token belongs to.                                                                    |
| `GET /workspaces`                    | The workspaces you belong to.                                                                |
| `POST /workspaces`                   | `{ name }` → a new workspace with you in it.                                                 |
| `GET /workspaces/:id`                | One workspace: members and review state.                                                     |
| `POST /workspaces/:id/members`       | `{ login }` → invite by GitHub login.                                                         |
| `POST /workspaces/:id/review`        | `{ action: request \| approve \| changes \| clear }`. The requester cannot approve.           |
| `POST /workspaces/:id/token`         | Mint a read token for this workspace, for the factory's secrets.                             |
| `GET /w/:id/plan.md`                 | The document as markdown — for a member's session or the workspace's read token.             |
| `WS /ws/:id?token=<session>`         | The live document: y-websocket's sync and awareness messages, plus review announcements.     |

A workspace you are not a member of answers `404`, never `403`: a stranger
learns nothing, not even that the id exists.

## Tests

```sh
pnpm --filter plans-workspaces test
```

Real HTTP and a real websocket against an in-process Postgres, so the suite
needs nothing installed. GitHub is stubbed only in the one test that is about
the device flow.
