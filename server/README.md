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

| Variable               | Default             | What it is                                                                     |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `PORT`                 | `8787`              |                                                                                |
| `HOST`                 | `127.0.0.1`         | Set `0.0.0.0` behind a reverse proxy that terminates TLS.                      |
| `WORKSPACES_DB`        | `workspaces.sqlite` | The one file that is the server's state. Back this up.                          |
| `GITHUB_CLIENT_ID`     | —                   | The GitHub OAuth app that sign-in goes through. Without it, sign-in is off.     |
| `WORKSPACES_DEV_LOGIN` | —                   | `1` enables `POST /auth/dev`, a session for a bare login. Tests and laptops only. |

Node 22.13 or newer: the database is `node:sqlite`, so there is nothing native
to build.

**The GitHub OAuth app** is an ordinary one from *Settings → Developer
settings → OAuth Apps*, with *Device flow* enabled. No callback URL matters,
because the desktop app has nowhere for GitHub to send anyone back to; the
app shows a code, the person types it at github.com, and this server does the
polling. The client id is not a secret, but it lives here rather than in the
app so that changing it does not mean shipping a build.

## What it holds

Users by GitHub login; sessions, as hashed tokens; workspaces, their members
(by login, so an invite can precede the invitee's first sign-in), the review
state; and each workspace's document as a Yjs update blob. The document's
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

Real HTTP and a real websocket against an in-memory database. GitHub is
stubbed only in the one test that is about the device flow.
