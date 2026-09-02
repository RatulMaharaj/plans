---
status: draft
---
# A workspace mirrors to a git branch

The second of three plans, after `workspace-tree.md`. A workspace's truth is
the database; this puts a copy of it on a git branch, continuously, so that
everything that works from a checkout - the factory, a local agent, a
reviewer with a terminal - can reach it.

## Problem

Realtime needs keystroke granularity and git syncs at commit granularity, so
git cannot be the workspace's medium. But every agent runs against a
checkout, and the factory dispatches from a branch. Without a checkout to
point at, a workspace is invisible to the machinery the rest of the product
is built on.

## Approach

- **A workspace may name a mirror**: a repository and a branch, defaulting
  to `workspace/<workspace name>` on the repository the workspace was
  created against. Naming one is optional; without it a workspace is
  reachable only through the app and the read endpoint.
- **The server commits the tree to the branch.** After a change, debounced
  by a few seconds, the server writes the tree's files into a clone of the
  repository it keeps per workspace and commits with the members who edited
  since the last commit as co-authors, then pushes. A "Snapshot now" action
  in the app does the same without waiting.
- **Commits on the branch flow back.** The server fetches the branch on a
  cadence and on a webhook; a commit it did not make is applied to the tree
  as a transaction per changed file, using the same "outside edit" path the
  app already has for a file changed on disk. This is how an implementing
  agent's `done` flip and its notes reach the people in the room.
- **The mirror is never the truth.** A conflict between a live edit and an
  incoming commit resolves for the live document; the incoming text is
  offered the way a disk conflict is offered today, and never overwrites.
- **Credentials**: the server pushes with a deploy key per mirror, minted
  when the mirror is named and shown once for the human to add to the
  repository. No personal tokens on the server.

## Implementation guide

- [ ] `server/src/schema.js` + a migration - `mirrors`: workspace, remote,
      branch, key, last pushed and fetched commits
- [ ] `server/src/mirror.js` - the clone per workspace under the data
      directory, the debounced commit-and-push, the fetch-and-apply, and the
      conflict rule
- [ ] `server/Dockerfile` - `git` and `openssh-client` in the image; a volume
      for the clones
- [ ] `server/src/index.js` - name, rotate and remove a mirror; "snapshot
      now"; a webhook endpoint for pushes
- [ ] `src/App.tsx` - the mirror in the workspace's page head: named, last
      snapshot, snapshot now
- [ ] `server/test/` - a bare repository as the remote; a change becomes a
      commit; a commit becomes a change; a conflict keeps the live text

## Out of scope

Dispatching the factory from the mirror and anything about who is allowed
to flip a plan to `ready` from where: `workspace-agents-and-sharing.md`.

## Open questions

- Cadence: seconds of debounce means a commit per burst of typing, which is
  a noisy history. A commit per "quiet minute", plus snapshot on demand?
- Co-authorship: the members' emails are known; is a commit per editing
  session preferable to co-author trailers?
- Where the clones live in Coolify: a persistent volume on the app, or
  rebuild the clone from the branch on start and keep nothing?
