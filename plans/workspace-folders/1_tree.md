---
status: ready
---
# A workspace is a folder of files

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

The first half of one feature: this makes a workspace a tree of files that
everyone edits live, and `2_files-not-workspaces.md` re-points the read
endpoint and share links at files and retires the review gate. Mirroring
the tree to a git branch is `../workspace-mirror.md`, a draft left for
later; nothing here depends on it.

## Problem

`hosted-workspaces.md` shipped a workspace as one document. What is wanted is
a folder: files and folders created, renamed, moved and deleted as on disk,
every change visible to everyone as it happens, each file edited together
the way the one document is today.

## Approach

Everything stays on Yjs; nothing new is deployed.

- **The tree is a shared document.** One Yjs document per workspace, the
  `tree` room, holds a map of path → `{ kind: "file" | "folder", doc: id }`.
  Create, rename, move and delete are transactions on that map, so they land
  for everyone at once and merge if two people act together. A rename is a
  move of the key; the file's document id does not change.
- **Each file is its own document**, in its own room keyed by the document
  id, exactly the room the single-document workspace has today. The editor's
  collab mode binds to it unchanged; `meta.markdown` on each file document
  is what the server reads back as the file's text.
- **Persistence is Postgres**: the `docs` table already stores one Yjs state
  per room. A workspace's rooms are its tree plus one per file. S3 is not
  needed over Postgres and its backups.
- **In the app a workspace looks like a repository.** It joins the file tree
  as a heading with its folders and files, rather than the separate
  "Workspaces" region that shipped: the tree already knows how to draw a
  folder structure, filter it, and offer new-file, rename, move and delete.
  What is disk-only goes dark for a workspace: git marks, reveal in Finder,
  open in terminal, the git panel. Templates work as they do for a
  repository, writing into the tree instead of onto disk.
- **Tabs and buffers**: a workspace file is a memory buffer keyed by
  `workspace id / path`, as today's single document is keyed by workspace
  id, so every disk-write path still refuses it without being told.
- What shipped is the special case of a tree with one file called
  `plan.md`; existing workspaces are migrated by writing that entry into a
  new tree document. Nothing is thrown away.

## Implementation guide

- [ ] `server/src/rooms.js` - rooms keyed by document id; a workspace's tree
      room and file rooms; membership checked against the workspace the
      document belongs to
- [ ] `server/src/schema.js` + a migration - `docs` gains `workspace_id` and
      `kind` so a file room can be authorised; the tree entry for existing
      workspaces is written by the migration
- [ ] `server/src/index.js` - `GET /workspaces/:id/tree` for a cold open,
      and the websocket path takes a document id
- [ ] `src/workspace.ts` - open the tree room, expose it as a `PlanFile[]`
      the tree can draw, and open file rooms on demand
- [ ] `src/FileTree.tsx` / `src/App.tsx` - a workspace as a repository
      heading with the disk-only actions hidden; new file, rename, move and
      delete as tree transactions
- [ ] `src/Editor.tsx` - unchanged; one editor per file room
- [ ] `e2e/workspace.spec.ts` - two contexts: one creates a folder and a
      file, the other sees them appear and opens the file; a rename lands on
      both sides mid-edit

## Out of scope

Mirroring to git (`../workspace-mirror.md`, later). Share links and the
read endpoint per file, and the review gate, are the second half of this
folder.

## Open questions

- Does a folder exist on its own, or only as a prefix of a file path, as in
  git? A tree map can hold folders explicitly, which the app's "show all
  folders" mode would want.
- One tree room per workspace means the tree's history grows with every
  rename; Yjs handles it, but should the tree document be compacted on save?
