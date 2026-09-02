---
status: draft
---
# A workspace is a folder, not a page

> "A workspace is a plan argued out with others before it is a file." - that's
> not quite what a workspace is. I want it to be like a collaborative type of
> space where we can create md files similar to how they would exist in a
> repo, just not have it backed by a repo (or maybe?) but we need realtime
> sync. So I should be able to create files and folders as I normally would.
> Others should see everything in realtime. Agents should be able to reach in
> and grab a plan and start implementing. I feel like we might want a
> workspace to just be a special type of git repo? Or have the option to sync
> with a git repo (or s3 bucket) or just our database. I'm not sure, but I
> need fast and realtime.

## Problem

`hosted-workspaces.md` shipped a workspace as one document with a review
gate. What is wanted is a folder of markdown files that behaves like a
repository: create files and folders as you would on disk, everyone sees
every change as it happens, and an agent can pick a `ready` plan out of it
and implement it. Realtime rules out git as the medium, since git syncs at
commit granularity; and "backed by a repo" is what makes agents work, since
every agent runs against a checkout.

## Approach

Truth in the database, git as the mirror.

- **The tree is a shared document.** One Yjs document per workspace holds
  the tree: paths, folders, renames, moves, deletes, as transactions, so a
  new file lands for everyone at once. One Yjs document per file holds its
  text; the editor's collab mode already binds to those.
- **Persistence is Postgres**, which the server already has and which is
  backed up with the rest of looped. S3 buys nothing over that.
- **A workspace is mirrored to a git branch.** The server commits the tree
  to `workspace/<name>` on a repository the workspace names, on a short
  cadence and on demand. The mirror is the agent-facing face of the
  workspace: the factory dispatches on a plan flipping to `ready` on that
  branch exactly as it does for any branch, and an implementing agent's
  commits on the branch flow back into the workspace's documents. The
  mirror is never the source of truth; a conflict resolves in favour of the
  live document.
- **In the app a workspace looks like a repository**: a heading in the tree
  with folders and files, opened like any file. The disk-only affordances go
  dark for it (git marks, reveal in Finder, terminal); everything else -
  templates, frontmatter, status, rename, move, delete - is the same
  gesture. This reverses the "own region" decision in `hosted-workspaces.md`
  now that a workspace has a tree.
- **The review gate goes.** `status:` in frontmatter and `approved` as the
  human's word already say what the gate said, and they travel with the file
  through the mirror.
- What shipped becomes a workspace with one file; nothing is thrown away.

## Open questions

- Does a workspace have to name a mirror repository, or is mirroring
  optional? Without a mirror, agents cannot reach it; with one, the
  workspace needs a token that can push to that repository.
- Mirror cadence: every change debounced by seconds, or a "snapshot" button,
  or both? The factory only cares about `ready` flips landing.
- Do the factory's commits on the mirror branch write back into the
  workspace automatically, or is that a "pull" the human asks for?
- Share links and the read endpoint were per document; per file now, or
  per workspace?
