---
status: done
---
# Hosted Workspaces

## What shipped, and the three decisions that unblocked it

An earlier run put this plan down because its first item was another
repository and two of its open questions decided the app's shape. Both were
answered rather than guessed, and the plan went through as one unit:

- **The server lives in this repository**, under `server/`, as a second
  package in the pnpm workspace. One Node process, `node:sqlite`, `ws`, and
  the y-websocket protocol written out in a hundred lines. No native build,
  no framework. `server/README.md` is its whole manual.
- **A workspace is its own region of the sidebar**, under the tree, not a
  heading inside it. The tree's machinery assumes paths on disk everywhere it
  walks; a workspace has a name, members and a review state, and that is all
  its row shows.
- **The server's address is fixed in the app**, not a setting. The one
  override is for development and the browser tests, which start a server of
  their own and point the app at it through `localStorage`. The address is a
  constant in `src/workspace.ts`; deploying the server is what makes it true.

What the GitHub OAuth app needs is one client id, held by the server as an
environment variable so that changing it never means shipping a build. Until
one is registered the server says sign-in is not configured, and the app's
sheet says so too.

A workspace is a room where a plan gets argued: a hosted markdown document
several people edit at once, with cursors, presence, and a review gate at the
end. When the argument settles, the plan leaves the room — committed into a
local repository — and everything downstream (agents, the factory, git) works
exactly as it does today. The workspace is *upstream* of the file world, not a
replacement for it.

## This contradicts collaboration.md, on purpose

That plan's thesis was "the repo is the server, git is the sync protocol, and
a person is whoever `git config user.name` says they are"
(plans/collaboration.md:6–11), and it shipped: comments live in the file as
HTML, identity is git config, nothing needs a backend. That answer is right
for plans that *have* a repo and collaborators who share it.

Hosted workspaces exist for the moment before that is true: two people
hammering out a plan in real time, one of whom may not have the repo cloned or
git installed. Git syncs at commit granularity; realtime co-editing needs
keystroke granularity, and "seeing others' cursors" is not something a
`.git` directory can be made to do. So this is not the collaboration plan
losing the argument — it is a different phase of a plan's life needing a
different medium. The bridge between the phases is the copy-to-repo command,
and the design below treats that bridge as load-bearing, not a convenience.

## A second program

Everything in this repository is one Tauri app whose data is files on disk.
A workspace needs a machine that is up when your collaborator's laptop is
not, so this plan implies a small hosted service — auth, document
persistence, a Yjs websocket relay, review state, one read endpoint. It
should be its own repository and deployment; nothing in this app's backend
(src-tauri) should grow network-service concerns. The app is a *client* of
the workspace server, the way it is already a client of the agents it spawns.

Keep the server boring: a single Node process, SQLite, `y-websocket` or its
equivalent. The moment it wants a queue or a second database, the scope has
slipped.

## The third kind of buffer

The app already proves it can host a document that is not a file. The
`MEMORY` sentinel gives release notes a buffer with no repository behind it,
and — the comment is explicit — "every write path already refuses them
without being told to" (src/App.tsx:119–129). Workspace documents are the
third kind: not a repo file, not a throwaway memory buffer, but a document
whose truth lives in a CRDT on the wire.

That framing decides what *not* to build. The app's hardest-won machinery —
the stamp poll (src/App.tsx:1047–1067), the conflict bar, autosave, the
"absent is not a stamp" rule — exists because disk is a shared mutable thing
the app does not control. A Yjs document has none of those problems: sync is
continuous, merge is the data type's job, and "save" is not an operation a
person performs. So workspace buffers must *bypass* that machinery the way
MEMORY buffers do, not be taught to it. A `WORKSPACE` sentinel (or a
`workspace://id` pseudo-path) rides the same rails: not in `repos`, so
`activeRepo` is null and every disk-write path refuses it by construction.

## Realtime is Yjs, and the wiring change is in Editor

The editor is Milkdown Crepe (src/Editor.tsx:2), and Milkdown ships a collab
plugin over `y-prosemirror` — cursors and presence come with Yjs awareness
rather than being a feature we design. The real change is to Editor's
interface: today it takes `initialValue` markdown and reports serialized
markdown back through `onChange`, with `replaceAll` for wholesale swaps
(src/Editor.tsx:5, and the source-of-truth note at src/Editor.tsx:52). A
collab buffer binds the ProseMirror doc to the Yjs doc instead; markdown
serialization still happens — the copy-to-repo command and the agent endpoint
both need it — but it becomes a *read* of the document, not the channel edits
travel through.

Presence indicators outside the document (who is in the workspace, who is
typing) come from the same awareness protocol, rendered wherever the
workspace's heading lives in the sidebar. No polling, no separate presence
system.

## Sign in with GitHub, but by device flow

Identity has to be real here in a way collaboration.md's `git config` answer
is not, because the review rule — the author cannot approve their own plan —
is only as strong as the identity system under it. GitHub is the right
issuer: everyone this app is for has an account, and review semantics are
borrowed from PRs anyway.

The draft says "opens in browser, redirects to app". Argue for the OAuth
*device flow* instead: the app shows a short code, opens github.com/login/device
in the browser through the `openUrl` plugin it already uses
(src/App.tsx:5), and polls for the grant. A redirect back into the app needs a
custom URL scheme registered with the OS and a deep-link handler — real
machinery, and famously flaky when the app isn't the default handler or two
copies are installed (this project runs a dev build and a release build side
by side as a matter of course). Device flow needs neither: no scheme, no
loopback server, and the failure mode is "type the code yourself". The token
lives in the OS keychain, not localStorage.

## Reviews are server state, not frontmatter

The temptation is to put `status: approved` in the document's frontmatter,
because the whole app already renders status from there (statusTone,
src/matter.ts:117–124). But frontmatter is document text, and in a workspace
*everyone can edit the document* — an approval anyone can type is not an
approval. Review state (requested, approved-by, changes-requested) belongs to
the server, keyed by GitHub login, with author ≠ approver enforced where the
clients can't reach. The app renders it in the same visual vocabulary as the
status chip so the board reads as one system, and the copy-to-repo command
writes the outcome *into* the committed file's frontmatter (`status: ready`,
and an `approved-by:` line) — at that point the file is entering git, where
history makes tampering visible and the guarantee changes custodian.

## The bridge: copy to a repository

One command — "Copy to repository…" — takes the workspace document's
markdown and writes it into a chosen repo and folder. Every piece exists:
`writePlan` (src/api.ts:208), and the NameSheet already picks a repository
and destination folder for new files (src/App.tsx:4571–4580 region). The copy
is a snapshot: the review trail and the live document stay in the workspace,
and the file begins an ordinary git life. This is also the primary way
*agents* meet a workspace plan, because agents in this app run against a
working directory — the session is opened with the repo as its cwd
(src-tauri/src/agent/session.rs:156–163) — and a hosted document has none.

## The endpoint, and why it is not public

For agents that do not run on your machine — the factory's workers and
Actions runs (plans/github-actions-agents.md) — the workspace serves
`GET /w/{workspace}/plan.md` with a bearer token minted per workspace.
Not a public URL with an unguessable id: plans are unreleased intent, and
"security by long id" fails the first time a URL lands in a CI log. The token
goes in the factory's secrets the way its other credentials already do. The
response is the same serialization the copy command writes, so a plan reads
identically whichever door it came through.

## The v1 slice

Sign in, one workspace with one document, two people editing with visible
cursors, request-review/approve with the author rule, copy to repo. Not in
v1: multiple documents per workspace, comments (the in-file HTML comment
convention from collaboration.md carries over untouched), roles beyond
member, source-mode editing of a live workspace doc, and any kind of
workspace list UI beyond a section in the sidebar.

## Open questions

- Source mode for workspace buffers: `y-codemirror` exists, but binding two
  different editor surfaces to one Yjs doc through a markdown boundary is
  genuinely hard — the write surface edits the tree, the source surface edits
  the serialization. V1 forcing write mode is defensible; is it acceptable?
- Offline: Yjs merges happily after a disconnect, but should the app hold a
  local copy of workspace docs so one can be *read* offline? Leaning yes and
  trivial (IndexedDB persistence is a y- package), but it complicates "the
  server is the truth" storytelling.
- ~~Where does the server run and who pays?~~ Decided: a hosted default,
  fixed in the app. It is a container (`server/Dockerfile`) anyone can run,
  but the app does not offer a field for it.
- Does review state need to survive into the file as more than frontmatter —
  e.g. the full approval trail as an HTML comment block, in the spirit of
  everything-in-the-file? It would let the PR skill quote it.
- Invites: by GitHub login only, or a link that grants membership on first
  sign-in? Links are how these tools actually spread; tokens-in-links is the
  tension.
- ~~Does the sidebar treat a workspace as a peer of a repository or as a
  different region?~~ Decided: its own region, under the tree.

## Next

- [x] Workspace server in `server/`: GitHub device-flow auth proxied so the
      app never holds a GitHub token, SQLite, Yjs websocket relay with
      per-doc rooms, membership checked on socket upgrade
- [x] Sign-in UI in the rail (top left), token in the OS keychain through
      the `keyring` crate, account chip with sign-out
- [x] The workspace buffer rides the MEMORY rails: repo `MEMORY`, path
      `\0ws/<id>`, so every disk-write path already refuses it and no tab
      for it is restored on launch
- [x] Editor grows a collab mode: the room's Yjs doc bound via Milkdown's
      collab plugin, `initialValue` applied as a template only to an empty
      document, cursors and presence from awareness. `onChange` is kept —
      it is how the serialised markdown reaches the doc's `meta` map
- [x] Review state on the server (request, approve, changes; author ≠
      approver enforced there), announced over the socket, rendered in the
      status-chip vocabulary in the page head
- [x] "Copy to repository…" through NameSheet + `createFile`, stamping
      `status: ready` and `approved-by:` into frontmatter when approved
- [x] `GET /w/{id}/plan.md` behind a per-workspace bearer token, answering
      with the same `meta.markdown` the copy path reads
- [x] e2e against a server the test starts: two browser contexts editing one
      doc, alice's cursor visible in bob's page; alice's Approve disabled and
      the server refusing it; the copied file lands in the fixture repo with
      the stamp
